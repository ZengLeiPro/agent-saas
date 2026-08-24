#!/usr/bin/env tsx
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { loadAppConfig } from '../app/config.js';
import { RuntimeEventRetention } from '../runtime/runtimeEventRetention.js';

const { Pool } = pg;

export const MIN_INDEX_OBSERVATION_MS = 7 * 24 * 60 * 60 * 1000;

export interface CliOptions {
  processCwd: string;
  connectionString?: string;
  tablePrefix?: string;
  executeRetention: boolean;
  legalDeleteThroughGlobalSequence?: string;
  authorizationRef?: string;
  batchLimit: number;
  maxBatchesPerCategory: number;
  executeDrop: boolean;
  dropRunIdx: boolean;
  indexObservedFrom?: string;
}

export interface ObservationWindowDecision {
  allowed: boolean;
  observedFrom?: Date;
  observedUntil?: Date;
  blocker?: string;
}

export interface IndexEvidence {
  indexName: string;
  indexDef: string;
  idxScan: bigint | null;
}

interface DatabaseClock {
  observedUntil: Date | string;
  statsReset: Date | string | null;
}

export interface ReplacementIndexEvidence {
  indexName: string;
  indexDef: string;
  accessMethod: string;
  firstKey: string | null;
  isValid: boolean;
  isReady: boolean;
  isPartial: boolean;
}

export function evaluateObservationWindow(input: {
  statsReset: Date | string | null | undefined;
  evidenceObservedFrom: Date | string | null | undefined;
  observedUntil: Date | string;
  minimumWindowMs?: number;
}): ObservationWindowDecision {
  const minimumWindowMs = input.minimumWindowMs ?? MIN_INDEX_OBSERVATION_MS;
  const observedUntil = toValidDate(input.observedUntil);
  if (!observedUntil) return { allowed: false, blocker: '数据库当前时间无效，拒绝删除任何索引。' };

  const statsReset = toValidDate(input.statsReset);
  if (!statsReset) return { allowed: false, blocker: 'stats_reset 缺失或无效，拒绝删除任何索引。' };
  const evidenceObservedFrom = toValidDate(input.evidenceObservedFrom);
  if (!evidenceObservedFrom) {
    return { allowed: false, blocker: '缺少有效的 --index-observed-from 证据起点，拒绝删除任何索引。' };
  }
  if (statsReset.getTime() > observedUntil.getTime()) {
    return { allowed: false, blocker: 'stats_reset 晚于数据库当前时间，拒绝删除任何索引。' };
  }
  if (evidenceObservedFrom.getTime() > observedUntil.getTime()) {
    return { allowed: false, blocker: '--index-observed-from 晚于数据库当前时间，拒绝删除任何索引。' };
  }

  const observedFrom = new Date(Math.max(statsReset.getTime(), evidenceObservedFrom.getTime()));
  const observedMs = observedUntil.getTime() - observedFrom.getTime();
  if (observedMs < minimumWindowMs) {
    const source = statsReset.getTime() >= evidenceObservedFrom.getTime() ? 'stats_reset 太新' : '索引观测窗口不足';
    return {
      allowed: false,
      observedFrom,
      observedUntil,
      blocker: `${source}：有效窗口 ${formatDuration(observedMs)}，至少需要 ${formatDuration(minimumWindowMs)}；拒绝删除任何索引。`,
    };
  }
  return { allowed: true, observedFrom, observedUntil };
}

export function evaluateZeroScanEvidence(evidence: {
  indexName: string;
  idxScan: bigint | null;
}): string | null {
  if (evidence.idxScan === null) return `${evidence.indexName} 缺少 pg_stat_user_indexes 统计，拒绝删除。`;
  if (evidence.idxScan !== 0n) return `${evidence.indexName} idx_scan=${evidence.idxScan.toString()}，不满足零扫描证据。`;
  return null;
}

export function isSessionReplacementIndex(evidence: ReplacementIndexEvidence): boolean {
  return evidence.accessMethod === 'btree'
    && evidence.isValid
    && evidence.isReady
    && !evidence.isPartial
    && normalizeIndexKey(evidence.firstKey) === 'session_id';
}

export function sameIndexDefinitionIgnoringName(a: string, b: string, aName: string, bName: string): boolean {
  const normalize = (value: string, name: string) => value
    .replace(name, '<index_name>')
    .replace(/\s+/g, ' ')
    .trim();
  return normalize(a, aName) === normalize(b, bName);
}

export function evaluateDropRecheck(input: {
  baselineStatsReset: Date | string | null | undefined;
  currentStatsReset: Date | string | null | undefined;
  evidenceObservedFrom: Date | string;
  observedUntil: Date | string;
  expectedCandidates: IndexEvidence[];
  currentCandidates: IndexEvidence[];
  expectedReplacements: ReplacementIndexEvidence[];
  currentReplacements: ReplacementIndexEvidence[];
}): string[] {
  const blockers: string[] = [];
  const baselineReset = toValidDate(input.baselineStatsReset);
  const currentReset = toValidDate(input.currentStatsReset);
  if (!baselineReset || !currentReset || baselineReset.getTime() !== currentReset.getTime()) {
    blockers.push('stats_reset 自整批初次取证后发生变化或无效，立即停止后续 DROP。');
  }

  const windowDecision = evaluateObservationWindow({
    statsReset: input.currentStatsReset,
    evidenceObservedFrom: input.evidenceObservedFrom,
    observedUntil: input.observedUntil,
  });
  if (!windowDecision.allowed) blockers.push(windowDecision.blocker!);

  const currentCandidates = new Map(input.currentCandidates.map((item) => [item.indexName, item]));
  for (const expected of input.expectedCandidates) {
    const current = currentCandidates.get(expected.indexName);
    if (!current) {
      blockers.push(`${expected.indexName} 在逐项复核时不存在，立即停止后续 DROP。`);
      continue;
    }
    const scanBlocker = evaluateZeroScanEvidence(current);
    if (scanBlocker) blockers.push(scanBlocker);
    if (current.indexDef !== expected.indexDef) {
      blockers.push(`${expected.indexName} 定义自整批初次取证后发生变化，立即停止后续 DROP。`);
    }
  }

  const currentReplacements = new Map(input.currentReplacements.map((item) => [item.indexName, item]));
  for (const expected of input.expectedReplacements) {
    const current = currentReplacements.get(expected.indexName);
    if (!current || !current.isValid || !current.isReady || current.isPartial) {
      blockers.push(`${expected.indexName} 替代索引缺失、失效、未 ready 或变为 partial，立即停止后续 DROP。`);
      continue;
    }
    if (current.indexDef !== expected.indexDef
      || current.accessMethod !== expected.accessMethod
      || normalizeIndexKey(current.firstKey) !== normalizeIndexKey(expected.firstKey)) {
      blockers.push(`${expected.indexName} 替代索引定义自整批初次取证后发生变化，立即停止后续 DROP。`);
    }
  }
  return blockers;
}

export function parseArgs(args: string[], processCwd = process.cwd()): CliOptions {
  const parsed: CliOptions = {
    processCwd,
    executeRetention: false,
    batchLimit: 10_000,
    maxBatchesPerCategory: 1,
    executeDrop: false,
    dropRunIdx: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--execute-retention') {
      parsed.executeRetention = true;
      continue;
    }
    if (arg === '--legal-delete-through') {
      parsed.legalDeleteThroughGlobalSequence = requireValue(args, ++i, arg);
      continue;
    }
    if (arg === '--authorization-ref') {
      parsed.authorizationRef = requireValue(args, ++i, arg);
      continue;
    }
    if (arg === '--batch-limit') {
      parsed.batchLimit = parseBoundedInt(requireValue(args, ++i, arg), arg, 1, 100_000);
      continue;
    }
    if (arg === '--max-batches-per-category') {
      parsed.maxBatchesPerCategory = parseBoundedInt(requireValue(args, ++i, arg), arg, 1, 1000);
      continue;
    }
    if (arg === '--execute-drop') {
      parsed.executeDrop = true;
      continue;
    }
    if (arg === '--drop-run-idx') {
      parsed.dropRunIdx = true;
      continue;
    }
    if (arg === '--index-observed-from') {
      const value = requireValue(args, ++i, arg);
      if (!toValidDate(value)) throw new Error(`${arg} 必须是有效 ISO-8601 时间`);
      parsed.indexObservedFrom = value;
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
  if ((parsed.executeRetention || parsed.executeDrop) && !parsed.authorizationRef) {
    throw new Error('写操作必须提供 --authorization-ref <变更/审批单号>');
  }
  if (parsed.executeRetention && !parsed.legalDeleteThroughGlobalSequence) {
    throw new Error('--execute-retention 必须提供 --legal-delete-through <global_sequence>');
  }
  if (parsed.executeDrop && !parsed.indexObservedFrom) {
    throw new Error('--execute-drop 必须提供 --index-observed-from <ISO-8601>，且有效观测窗口至少 7 天');
  }
  return parsed;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runtimeConfig = options.connectionString
    ? {
      connectionString: options.connectionString,
      tablePrefix: options.tablePrefix ?? 'runtime',
    }
    : resolveRuntimeConfig(options.processCwd, options.tablePrefix);

  const prefix = sanitizeIdentifier(runtimeConfig.tablePrefix ?? 'runtime');
  const eventsTable = `${prefix}_events`;
  const toolInvocationsTable = `${prefix}_tool_invocations`;
  const billingProjectionStateTable = `${prefix}_billing_projection_state`;
  const pool = new Pool({ connectionString: runtimeConfig.connectionString });

  try {
    await printReadOnlyChecks(pool, eventsTable, billingProjectionStateTable);
    const retention = new RuntimeEventRetention({
      pool,
      eventsTable,
      toolInvocationsTable,
      billingProjectionStateTable,
      executionMode: options.executeRetention ? 'execute' : 'dry-run',
      legalDeleteThroughGlobalSequence: options.legalDeleteThroughGlobalSequence,
      authorizationRef: options.authorizationRef,
      batchLimit: options.batchLimit,
      maxBatchesPerCategory: options.maxBatchesPerCategory,
      logger: { info: console.log, warn: console.warn },
    });
    console.log('\n== 5. bounded runtime event retention ==');
    console.log(JSON.stringify(await retention.runOnce(), null, 2));
    if (!options.executeRetention) {
      console.log('[dry-run] 默认只读；执行删除需同时传 --execute-retention、--legal-delete-through 与 --authorization-ref。');
    }
    if (options.executeDrop) {
      const client = await pool.connect();
      try {
        await dropDeadIndexes(client, eventsTable, {
          dropRunIdx: options.dropRunIdx,
          indexObservedFrom: options.indexObservedFrom!,
        });
      } finally {
        client.release();
      }
    } else {
      console.log('\n[skip] 未传 --execute-drop，仅执行只读核查。');
    }
  } finally {
    await pool.end();
  }
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
      s.idx_scan,
      s.idx_tup_read,
      s.idx_tup_fetch,
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

export async function dropDeadIndexes(
  target: Pick<pg.PoolClient, 'query'>,
  table: string,
  options: { dropRunIdx: boolean; indexObservedFrom: string },
): Promise<void> {
  const ginIdx = `${table}_event_json_gin_idx`;
  const sessionIdx = `${table}_session_idx`;
  const runIdx = `${table}_run_idx`;
  const sessionRunIdx = `${table}_session_run_idx`;
  const lockName = `runtime-events-maintenance:drop:${table}`;

  await target.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [lockName]);
  try {
    const clock = await readDatabaseClock(target);
    const windowDecision = evaluateObservationWindow({
      statsReset: clock.statsReset,
      evidenceObservedFrom: options.indexObservedFrom,
      observedUntil: clock.observedUntil,
    });
    if (!windowDecision.allowed) throw new Error(windowDecision.blocker);

    const candidateNames = [ginIdx, sessionIdx, ...(options.dropRunIdx ? [runIdx] : [])];
    const candidateEvidence = await readIndexEvidence(target, table, candidateNames);
    const replacements = await readReplacementIndexes(target, table, candidateNames);
    const byName = new Map(candidateEvidence.map((item) => [item.indexName, item]));
    const blockers: string[] = [];
    const dropPlan: IndexEvidence[] = [];
    const requiredReplacements: ReplacementIndexEvidence[] = [];

    for (const indexName of candidateNames) {
      const evidence = byName.get(indexName);
      if (!evidence) {
        console.log(`[skip] ${indexName} 不存在。`);
        continue;
      }
      const scanBlocker = evaluateZeroScanEvidence(evidence);
      if (scanBlocker) blockers.push(scanBlocker);
      dropPlan.push(evidence);
    }

    if (byName.has(sessionIdx)) {
      const sessionReplacement = replacements.find(isSessionReplacementIndex);
      if (!sessionReplacement) {
        blockers.push(`${sessionIdx} 缺少有效、ready、非 partial 且以 session_id 为首列的 btree 替代索引。`);
      } else {
        requiredReplacements.push(sessionReplacement);
        console.log(`[evidence] ${sessionIdx} 替代索引 ${sessionReplacement.indexName}: ${sessionReplacement.indexDef}`);
      }
    }

    if (options.dropRunIdx && byName.has(runIdx)) {
      const runDef = byName.get(runIdx)!.indexDef;
      const replacement = replacements.find((item) => item.indexName === sessionRunIdx);
      if (!replacement || !replacement.isValid || !replacement.isReady || replacement.isPartial) {
        blockers.push(`${sessionRunIdx} 不存在、失效、未 ready 或为 partial，拒绝删除 ${runIdx}。`);
      } else if (!sameIndexDefinitionIgnoringName(runDef, replacement.indexDef, runIdx, sessionRunIdx)) {
        blockers.push(`${runIdx} 与 ${sessionRunIdx} 定义不等价，拒绝删除。`);
      } else {
        requiredReplacements.push(replacement);
        console.log(`[evidence] ${runIdx} 等价替代索引 ${sessionRunIdx}: ${replacement.indexDef}`);
      }
    }

    if (blockers.length > 0) {
      throw new Error(`索引 DROP 证据门禁失败；本次未执行任何 DROP：\n- ${blockers.join('\n- ')}`);
    }

    console.log(`[evidence] 有效观测窗口 ${windowDecision.observedFrom!.toISOString()} - ${windowDecision.observedUntil!.toISOString()}；候选索引均 idx_scan=0。`);
    for (let index = 0; index < dropPlan.length; index++) {
      const remainingCandidates = dropPlan.slice(index);
      const recheckCandidates = await readIndexEvidence(
        target,
        table,
        remainingCandidates.map((item) => item.indexName),
      );
      const recheckReplacements = await readReplacementIndexes(target, table, candidateNames);
      const confirmedClock = await readDatabaseClock(target);
      const recheckBlockers = evaluateDropRecheck({
        baselineStatsReset: clock.statsReset,
        currentStatsReset: confirmedClock.statsReset,
        evidenceObservedFrom: options.indexObservedFrom,
        observedUntil: confirmedClock.observedUntil,
        expectedCandidates: remainingCandidates,
        currentCandidates: recheckCandidates,
        expectedReplacements: requiredReplacements,
        currentReplacements: recheckReplacements,
      });
      if (recheckBlockers.length > 0) {
        throw new Error(`索引 DROP 逐项复核失败；立即停止后续 DROP：\n- ${recheckBlockers.join('\n- ')}`);
      }
      await dropIndexConcurrently(target, dropPlan[index]!.indexName);
    }
    if (!options.dropRunIdx) {
      console.log(`[skip] ${runIdx} 需独立零扫描与等价替代证据；传 --drop-run-idx 后才纳入整批门禁。`);
    }
  } finally {
    await target.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lockName]);
  }
}

async function readDatabaseClock(target: Pick<pg.PoolClient, 'query'>): Promise<DatabaseClock> {
  const result = await target.query<{ observed_until: Date | string; stats_reset: Date | string | null }>(`
    SELECT now() AS observed_until, stats_reset
    FROM pg_stat_database
    WHERE datname = current_database()
  `);
  return {
    observedUntil: result.rows[0]?.observed_until ?? '',
    statsReset: result.rows[0]?.stats_reset ?? null,
  };
}

async function readIndexEvidence(target: Pick<pg.PoolClient, 'query'>, table: string, indexNames: string[]): Promise<IndexEvidence[]> {
  const result = await target.query<{ index_name: string; index_def: string; idx_scan: string | null }>(`
    SELECT c.relname AS index_name,
           pg_get_indexdef(i.indexrelid) AS index_def,
           s.idx_scan::text AS idx_scan
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
    WHERE i.indrelid = $1::regclass
      AND c.relname = ANY($2::text[])
  `, [table, indexNames]);
  return result.rows.map((row) => ({
    indexName: row.index_name,
    indexDef: row.index_def,
    idxScan: row.idx_scan === null ? null : BigInt(row.idx_scan),
  }));
}

async function readReplacementIndexes(
  target: Pick<pg.PoolClient, 'query'>,
  table: string,
  excludedNames: string[],
): Promise<ReplacementIndexEvidence[]> {
  const result = await target.query<{
    index_name: string;
    index_def: string;
    access_method: string;
    first_key: string | null;
    is_valid: boolean;
    is_ready: boolean;
    is_partial: boolean;
  }>(`
    SELECT c.relname AS index_name,
           pg_get_indexdef(i.indexrelid) AS index_def,
           am.amname AS access_method,
           CASE WHEN i.indnkeyatts > 0 THEN pg_get_indexdef(i.indexrelid, 1, true) END AS first_key,
           i.indisvalid AS is_valid,
           i.indisready AS is_ready,
           i.indpred IS NOT NULL AS is_partial
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_am am ON am.oid = c.relam
    WHERE i.indrelid = $1::regclass
      AND NOT (c.relname = ANY($2::text[]))
  `, [table, excludedNames]);
  return result.rows.map((row) => ({
    indexName: row.index_name,
    indexDef: row.index_def,
    accessMethod: row.access_method,
    firstKey: row.first_key,
    isValid: row.is_valid,
    isReady: row.is_ready,
    isPartial: row.is_partial,
  }));
}

async function dropIndexConcurrently(target: Pick<pg.PoolClient, 'query'>, indexName: string): Promise<void> {
  const safe = sanitizeIdentifier(indexName);
  console.log(`[drop] DROP INDEX CONCURRENTLY IF EXISTS ${safe}`);
  await target.query(`DROP INDEX CONCURRENTLY IF EXISTS ${safe}`);
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

function parseBoundedInt(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} 必须是整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须在 ${min}-${max} 之间`);
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

function toValidDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDuration(ms: number): string {
  const days = ms / (24 * 60 * 60 * 1000);
  return `${Number(days.toFixed(2))} 天`;
}

function normalizeIndexKey(value: string | null): string | null {
  if (!value) return null;
  return value.trim().replace(/^"|"$/g, '').toLowerCase();
}

function isDirectExecution(metaUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  return fileURLToPath(metaUrl) === resolve(argvEntry);
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
  await main();
}
