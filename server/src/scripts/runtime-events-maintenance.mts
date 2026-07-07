#!/usr/bin/env tsx
import pg from 'pg';

import { loadAppConfig } from '../app/config.js';

const { Pool } = pg;

interface CliOptions {
  processCwd: string;
  connectionString?: string;
  tablePrefix?: string;
  executeDrop: boolean;
  dropRunIdx: boolean;
}

const options = parseArgs(process.argv.slice(2));
const runtimeConfig = options.connectionString
  ? {
    connectionString: options.connectionString,
    tablePrefix: options.tablePrefix ?? 'runtime',
  }
  : resolveRuntimeConfig(options.processCwd, options.tablePrefix);

const prefix = sanitizeIdentifier(runtimeConfig.tablePrefix ?? 'runtime');
const eventsTable = `${prefix}_events`;
const billingProjectionStateTable = `${prefix}_billing_projection_state`;
const pool = new Pool({ connectionString: runtimeConfig.connectionString });

try {
  await printReadOnlyChecks(pool, eventsTable, billingProjectionStateTable);
  if (options.executeDrop) {
    await dropDeadIndexes(pool, eventsTable, { dropRunIdx: options.dropRunIdx });
  } else {
    console.log('\n[skip] 未传 --execute-drop，仅执行只读核查。');
  }
} finally {
  await pool.end();
}

async function printReadOnlyChecks(target: pg.Pool, table: string, projectionTable: string): Promise<void> {
  console.log('\n== 1. stats_reset + runtime_events index definitions / scans ==');
  console.table((await target.query(`
    SELECT datname, stats_reset
    FROM pg_stat_database
    WHERE datname = current_database()
  `)).rows);
  console.table((await target.query(`
    SELECT
      i.indexname,
      pg_get_indexdef(format('%I.%I', i.schemaname, i.indexname)::regclass) AS indexdef,
      COALESCE(s.idx_scan, 0) AS idx_scan,
      COALESCE(s.idx_tup_read, 0) AS idx_tup_read,
      COALESCE(s.idx_tup_fetch, 0) AS idx_tup_fetch,
      pg_size_pretty(pg_relation_size(format('%I.%I', i.schemaname, i.indexname)::regclass)) AS index_size
    FROM pg_indexes i
    LEFT JOIN pg_stat_user_indexes s
      ON s.schemaname = i.schemaname
     AND s.relname = i.tablename
     AND s.indexrelname = i.indexname
    WHERE i.schemaname = current_schema()
      AND i.tablename = $1
    ORDER BY i.indexname
  `, [table])).rows);

  console.log('\n== 2. runtime_events table / index size split ==');
  console.table((await target.query(`
    SELECT
      pg_size_pretty(pg_relation_size($1::regclass)) AS table_size,
      pg_size_pretty(pg_indexes_size($1::regclass)) AS indexes_size,
      pg_size_pretty(pg_total_relation_size($1::regclass)) AS total_size
  `, [table])).rows);
  console.table((await target.query(`
    SELECT
      indexrelid::regclass::text AS index_name,
      pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
    FROM pg_index
    WHERE indrelid = $1::regclass
    ORDER BY pg_relation_size(indexrelid) DESC
  `, [table])).rows);

  console.log('\n== 3. billing projection watermark vs runtime_events max(global_sequence) ==');
  console.table((await target.query(`
    SELECT
      COALESCE((SELECT last_global_sequence FROM ${projectionTable} WHERE key = 'runtime_events'), 0)::text AS billing_watermark,
      COALESCE((SELECT MAX(global_sequence) FROM ${table}), 0)::text AS max_global_sequence,
      (
        COALESCE((SELECT last_global_sequence FROM ${projectionTable} WHERE key = 'runtime_events'), 0)
        >= COALESCE((SELECT MAX(global_sequence) FROM ${table}), 0)
      ) AS caught_up
  `)).rows);

  console.log('\n== 4. runtime_events event_type distribution ==');
  console.table((await target.query(`
    SELECT event_type, COUNT(*)::text AS rows, MIN(timestamp) AS oldest_at, MAX(timestamp) AS newest_at
    FROM ${table}
    GROUP BY event_type
    ORDER BY COUNT(*) DESC, event_type ASC
  `)).rows);
}

async function dropDeadIndexes(
  target: pg.Pool,
  table: string,
  options: { dropRunIdx: boolean },
): Promise<void> {
  const ginIdx = `${table}_event_json_gin_idx`;
  const sessionIdx = `${table}_session_idx`;
  const runIdx = `${table}_run_idx`;
  const sessionRunIdx = `${table}_session_run_idx`;

  const ginScan = await readIdxScan(target, ginIdx);
  if (ginScan === null) {
    console.log(`[skip] ${ginIdx} 不存在。`);
  } else if (ginScan !== 0n) {
    throw new Error(`${ginIdx} idx_scan=${ginScan.toString()}，拒绝删除。先结合 stats_reset 判断是否真空闲。`);
  } else {
    await dropIndexConcurrently(target, ginIdx);
  }

  await dropIndexConcurrently(target, sessionIdx);

  if (!options.dropRunIdx) {
    console.log(`[skip] ${runIdx} 需结合生产定义判断；传 --drop-run-idx 且与 ${sessionRunIdx} 等价时才删除。`);
    return;
  }

  const [runDef, sessionRunDef] = await Promise.all([
    readIndexDef(target, runIdx),
    readIndexDef(target, sessionRunIdx),
  ]);
  if (!runDef) {
    console.log(`[skip] ${runIdx} 不存在。`);
    return;
  }
  if (!sessionRunDef) {
    throw new Error(`${sessionRunIdx} 不存在，拒绝删除 ${runIdx}。`);
  }
  if (!sameIndexDefinitionIgnoringName(runDef, sessionRunDef, runIdx, sessionRunIdx)) {
    throw new Error(`${runIdx} 与 ${sessionRunIdx} 定义不等价，拒绝删除。\nrun_idx=${runDef}\nsession_run_idx=${sessionRunDef}`);
  }
  await dropIndexConcurrently(target, runIdx);
}

async function readIdxScan(target: pg.Pool, indexName: string): Promise<bigint | null> {
  const result = await target.query<{ idx_scan: string }>(
    `SELECT idx_scan::text AS idx_scan
     FROM pg_stat_user_indexes
     WHERE schemaname = current_schema()
       AND indexrelname = $1`,
    [indexName],
  );
  return result.rows[0] ? BigInt(result.rows[0].idx_scan) : null;
}

async function readIndexDef(target: pg.Pool, indexName: string): Promise<string | null> {
  const result = await target.query<{ indexdef: string | null }>(
    `SELECT pg_get_indexdef(to_regclass($1)) AS indexdef`,
    [indexName],
  );
  return result.rows[0]?.indexdef ?? null;
}

async function dropIndexConcurrently(target: pg.Pool, indexName: string): Promise<void> {
  const safe = sanitizeIdentifier(indexName);
  console.log(`[drop] DROP INDEX CONCURRENTLY IF EXISTS ${safe}`);
  await target.query(`DROP INDEX CONCURRENTLY IF EXISTS ${safe}`);
}

function sameIndexDefinitionIgnoringName(a: string, b: string, aName: string, bName: string): boolean {
  const normalize = (value: string, name: string) => value
    .replace(name, '<index_name>')
    .replace(/\s+/g, ' ')
    .trim();
  return normalize(a, aName) === normalize(b, bName);
}

function resolveRuntimeConfig(processCwd: string, tablePrefix?: string): { connectionString: string; tablePrefix?: string } {
  const config = loadAppConfig(processCwd);
  if (config.runtimeEventStore?.backend !== 'pg') {
    throw new Error('当前 config.runtimeEventStore 不是 pg；请传 --connection-string 或切到生产 server cwd。');
  }
  return {
    connectionString: config.runtimeEventStore.connectionString,
    tablePrefix: tablePrefix ?? config.runtimeEventStore.tablePrefix,
  };
}

function parseArgs(args: string[]): CliOptions {
  const parsed: CliOptions = {
    processCwd: process.cwd(),
    executeDrop: false,
    dropRunIdx: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--execute-drop') {
      parsed.executeDrop = true;
      continue;
    }
    if (arg === '--drop-run-idx') {
      parsed.dropRunIdx = true;
      continue;
    }
    if (arg === '--cwd') {
      parsed.processCwd = requireValue(args, ++i, arg);
      continue;
    }
    if (arg === '--connection-string') {
      parsed.connectionString = requireValue(args, ++i, arg);
      continue;
    }
    if (arg === '--table-prefix') {
      parsed.tablePrefix = requireValue(args, ++i, arg);
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  return parsed;
}

function requireValue(args: string[], index: number, name: string): string {
  const value = args[index];
  if (!value) throw new Error(`${name} 缺少参数值`);
  return value;
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`非法 PG identifier: ${value}`);
  }
  return value;
}
