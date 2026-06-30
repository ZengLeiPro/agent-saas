/**
 * One-shot ETL: file-backed runtime events (`*.runtime-events.jsonl`) → PG runtime_events.
 *
 * 目标：在把默认 EventStore backend 从 file 切到 pg 之前，把现有 jsonl 历史
 * 灌进 PG，保证切换后 audit/replay/wake state 不会出现"历史断层"。
 *
 * 设计取舍：
 * - 不走 `PgEventStore.appendBatch`：那是 brain 在线 append 路径，会用自身 cursor
 *   分配 sequence，迁移历史时我们想保留 jsonl 的隐含行号作为 sequence，所以这
 *   里直连 PG 写 raw INSERT。
 * - 幂等：`ON CONFLICT (event_id) DO NOTHING`。已迁移的事件再跑不会重复。
 * - 默认 dry-run：`--execute` 才真写。dry-run 报告每个 session 在 PG 中的现状、
 *   会插入多少行、会跳过多少行。
 * - 默认拒绝覆盖：如果某 session 在 PG 中已经有事件而文件里的 event_id 跟 PG
 *   不完全重叠，**不写**（防止 mid-session 灌进去导致 sequence 错乱），输出
 *   conflict 提示，让运维人工决定（清表 / `--force`）。
 * - `--force`：允许把没 conflict 的 event_id 灌进已有 session，sequence 沿用
 *   jsonl 行号（撞了 UNIQUE(session_id, session_sequence) 会失败，整 session
 *   rollback）。慎用。
 * - cursor sync：迁移完一个 session，把 `runtime_event_cursors.next_sequence`
 *   推到 `MAX(session_sequence) + 1`（取与现存 cursor 的较大值），让切到 PG
 *   后第一次 append 不撞历史 sequence。
 *
 * Usage:
 *   pnpm -C server run migrate:events-file-to-pg -- --connection-string postgresql://... [opts]
 *
 * Options:
 *   --connection-string <url>   PG 连接串（execute 模式必填；dry-run 也建议传以读取现有数据）
 *   --table-prefix <prefix>     PG 表前缀，默认 runtime（与 runtimeEventStore.tablePrefix 对齐）
 *   --root <path>               扫描根目录，默认 ~/.claude/projects (ALLOWED_ROOT)
 *   --session <sessionId>       只迁指定 session（可重复）
 *   --limit <n>                 最多处理 n 个 session（dev 抽样用）
 *   --execute                   真写 PG；缺省=dry-run
 *   --force                     允许往已有事件的 session 追加（默认拒绝）
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import pg from 'pg';

import { ALLOWED_ROOT } from '../src/data/transcripts/projectKey.js';
import type { PlatformEvent } from '../src/runtime/types.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

const RUNTIME_EVENTS_SUFFIX = '.runtime-events.jsonl';

interface CliOptions {
  connectionString: string | undefined;
  tablePrefix: string;
  root: string;
  sessionFilter: Set<string> | null;
  limit: number | null;
  execute: boolean;
  force: boolean;
}

interface SessionPlan {
  sessionId: string;
  filePath: string;
  fileEvents: number;
  pgEventCount: number;
  pgMaxSequence: number;
  toInsert: number;
  willSkip: number;
  conflict: boolean;
  conflictReason?: string;
}

interface SessionResult extends SessionPlan {
  inserted: number;
  skipped: number;
  errors: number;
  error?: string;
}

function parseArgs(argv: string[]): CliOptions {
  function pick(name: string): string | undefined {
    const idx = argv.indexOf(name);
    if (idx >= 0) return argv[idx + 1];
    const prefix = `${name}=`;
    const found = argv.find((a) => a.startsWith(prefix));
    return found ? found.slice(prefix.length) : undefined;
  }
  function pickAll(name: string): string[] {
    const out: string[] = [];
    for (let i = 0; i < argv.length; i += 1) {
      if (argv[i] === name && argv[i + 1] !== undefined) {
        out.push(argv[i + 1]!);
        i += 1;
      } else if (argv[i]!.startsWith(`${name}=`)) {
        out.push(argv[i]!.slice(name.length + 1));
      }
    }
    return out;
  }
  const sessionList = pickAll('--session');
  const limitStr = pick('--limit');
  return {
    connectionString: pick('--connection-string'),
    tablePrefix: pick('--table-prefix') ?? 'runtime',
    root: pick('--root') ?? ALLOWED_ROOT,
    sessionFilter: sessionList.length > 0 ? new Set(sessionList) : null,
    limit: limitStr ? Math.max(1, Number.parseInt(limitStr, 10)) : null,
    execute: argv.includes('--execute'),
    force: argv.includes('--force'),
  };
}

function sanitizeIdentifier(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`非法 PG tablePrefix: ${value}`);
  }
  return value;
}

async function discoverFiles(root: string): Promise<Array<{ sessionId: string; filePath: string }>> {
  const out: Array<{ sessionId: string; filePath: string }> = [];
  let projectDirs: import('node:fs').Dirent[];
  try {
    projectDirs = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    throw err;
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const projectPath = join(root, dir.name);
    let files: import('node:fs').Dirent[];
    try {
      files = await readdir(projectPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile()) continue;
      if (!f.name.endsWith(RUNTIME_EVENTS_SUFFIX)) continue;
      const sessionId = f.name.slice(0, -RUNTIME_EVENTS_SUFFIX.length);
      if (!sessionId) continue;
      out.push({ sessionId, filePath: join(projectPath, f.name) });
    }
  }
  return out;
}

async function parseEventsFromFile(filePath: string): Promise<PlatformEvent[]> {
  const events: PlatformEvent[] = [];
  let bufRest = '';
  const handle = await open(filePath, 'r');
  try {
    const size = (await stat(filePath)).size;
    if (size === 0) return events;
    const buf = Buffer.alloc(size);
    let total = 0;
    while (total < size) {
      const { bytesRead } = await handle.read(buf, total, size - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    bufRest = buf.subarray(0, total).toString('utf-8');
  } finally {
    await handle.close().catch(() => undefined);
  }
  for (const line of bufRest.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as PlatformEvent;
      if (parsed && typeof parsed === 'object' && 'id' in parsed && 'type' in parsed) {
        events.push(parsed);
      }
    } catch {
      // 容错：append-only 文件偶尔有半行
    }
  }
  return events;
}

async function planSession(
  pool: PgPool,
  eventsTable: string,
  sessionId: string,
  filePath: string,
  force: boolean,
): Promise<SessionPlan> {
  const fileEvents = await parseEventsFromFile(filePath);
  const fileIds = new Set(fileEvents.map((e) => e.id));

  const existing = await pool.query<{ event_id: string; session_sequence: string }>(
    `SELECT event_id, session_sequence FROM ${eventsTable} WHERE session_id = $1`,
    [sessionId],
  );
  const existingIds = new Set(existing.rows.map((r) => r.event_id));
  const pgMaxSequence = existing.rows.reduce(
    (acc, row) => Math.max(acc, Number(row.session_sequence)),
    0,
  );
  const willSkip = fileEvents.filter((e) => existingIds.has(e.id)).length;
  const toInsert = fileEvents.length - willSkip;

  let conflict = false;
  let conflictReason: string | undefined;
  if (existingIds.size > 0 && !force) {
    // 已有 PG 记录：仅当 PG 完整覆盖文件（每个文件 event 都已在 PG）才放过
    const allCovered = fileEvents.every((e) => existingIds.has(e.id));
    if (!allCovered) {
      conflict = true;
      const pgOnly = [...existingIds].filter((id) => !fileIds.has(id));
      conflictReason = `session has ${existingIds.size} events in PG (max_seq=${pgMaxSequence})`
        + `; ${pgOnly.length} of them are NOT in this file. Re-run with --force only if you understand sequence semantics.`;
    }
  }

  return {
    sessionId,
    filePath,
    fileEvents: fileEvents.length,
    pgEventCount: existingIds.size,
    pgMaxSequence,
    toInsert,
    willSkip,
    conflict,
    ...(conflictReason ? { conflictReason } : {}),
  };
}

async function executeSession(
  pool: PgPool,
  eventsTable: string,
  cursorsTable: string,
  plan: SessionPlan,
): Promise<SessionResult> {
  if (plan.conflict) {
    return { ...plan, inserted: 0, skipped: 0, errors: 0 };
  }
  if (plan.fileEvents === 0) {
    return { ...plan, inserted: 0, skipped: 0, errors: 0 };
  }

  const events = await parseEventsFromFile(plan.filePath);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    let inserted = 0;
    let skipped = 0;
    for (let i = 0; i < events.length; i += 1) {
      const evt = events[i]!;
      const seq = i + 1; // 行号即 session_sequence（1-based）
      const result = await client.query(
        `INSERT INTO ${eventsTable}
           (session_id, session_sequence, event_id, event_type, run_id, timestamp, event_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         ON CONFLICT (event_id) DO NOTHING
         RETURNING global_sequence`,
        [
          plan.sessionId,
          seq,
          evt.id,
          evt.type,
          'runId' in evt ? evt.runId : null,
          evt.timestamp,
          JSON.stringify(evt),
        ],
      );
      if (result.rowCount && result.rowCount > 0) {
        inserted += 1;
      } else {
        skipped += 1;
      }
    }

    // cursor sync：让后续 append 接着 jsonl 末尾的 sequence + 1（与现存 cursor 取较大值）
    const targetCursor = events.length + 1;
    await client.query(
      `INSERT INTO ${cursorsTable} (session_id, next_sequence)
       VALUES ($1, $2)
       ON CONFLICT (session_id) DO UPDATE SET next_sequence = GREATEST(${cursorsTable}.next_sequence, EXCLUDED.next_sequence)`,
      [plan.sessionId, targetCursor],
    );

    await client.query('COMMIT');
    return { ...plan, inserted, skipped, errors: 0 };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    return {
      ...plan,
      inserted: 0,
      skipped: 0,
      errors: 1,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    client.release();
  }
}

async function ensureTablesExist(pool: PgPool, eventsTable: string, cursorsTable: string): Promise<void> {
  // 与 PgEventStore.init() 等价：ETL 在 brain 启动前/后都能跑（如果 brain 还没建表）
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${cursorsTable} (
      session_id TEXT PRIMARY KEY,
      next_sequence BIGINT NOT NULL DEFAULT 1
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${eventsTable} (
      global_sequence BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      session_sequence BIGINT NOT NULL,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      run_id TEXT,
      timestamp TIMESTAMPTZ NOT NULL,
      event_json JSONB NOT NULL,
      UNIQUE(session_id, session_sequence)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${eventsTable}_session_idx
    ON ${eventsTable} (session_id, session_sequence)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${eventsTable}_run_idx
    ON ${eventsTable} (run_id)
    WHERE run_id IS NOT NULL
  `);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.connectionString) {
    console.error('ERROR: --connection-string is required (dry-run still queries PG for current state).');
    process.exit(2);
  }

  const eventsTable = `${sanitizeIdentifier(opts.tablePrefix)}_events`;
  const cursorsTable = `${sanitizeIdentifier(opts.tablePrefix)}_event_cursors`;

  console.log(`[start] mode=${opts.execute ? 'EXECUTE' : 'DRY-RUN'} force=${opts.force} root=${opts.root}`);
  console.log(`[start] PG tablePrefix=${opts.tablePrefix} → ${eventsTable} / ${cursorsTable}`);

  const pool = new Pool({ connectionString: opts.connectionString });
  pool.on('error', (err) => {
    console.warn(`[warn] pg pool idle client error: ${err instanceof Error ? err.message : String(err)}`);
  });

  try {
    await ensureTablesExist(pool, eventsTable, cursorsTable);

    let candidates = await discoverFiles(opts.root);
    if (opts.sessionFilter) {
      candidates = candidates.filter((c) => opts.sessionFilter!.has(c.sessionId));
    }
    if (opts.limit !== null) {
      candidates = candidates.slice(0, opts.limit);
    }
    console.log(`[scan] discovered ${candidates.length} runtime-events.jsonl file(s) under root`);

    const plans: SessionPlan[] = [];
    for (const { sessionId, filePath } of candidates) {
      const plan = await planSession(pool, eventsTable, sessionId, filePath, opts.force);
      plans.push(plan);
    }

    // 汇总
    const aggregate = {
      sessions: plans.length,
      totalFileEvents: plans.reduce((acc, p) => acc + p.fileEvents, 0),
      totalToInsert: plans.reduce((acc, p) => acc + (p.conflict ? 0 : p.toInsert), 0),
      totalWillSkip: plans.reduce((acc, p) => acc + p.willSkip, 0),
      conflicts: plans.filter((p) => p.conflict).length,
      emptySessions: plans.filter((p) => p.fileEvents === 0).length,
    };
    console.log('[plan] aggregate:', JSON.stringify(aggregate));

    if (aggregate.conflicts > 0) {
      console.log('[plan] conflict sessions (top 10):');
      for (const p of plans.filter((x) => x.conflict).slice(0, 10)) {
        console.log(`  - ${p.sessionId}: ${p.conflictReason}`);
      }
    }

    if (!opts.execute) {
      console.log('[done] dry-run only — pass --execute to write PG');
      return;
    }

    let inserted = 0;
    let skipped = 0;
    let errors = 0;
    let processed = 0;
    for (const plan of plans) {
      const result = await executeSession(pool, eventsTable, cursorsTable, plan);
      inserted += result.inserted;
      skipped += result.skipped;
      errors += result.errors;
      processed += 1;
      if (result.errors > 0) {
        console.warn(`[error] session=${result.sessionId} ${result.error ?? '(unknown)'}`);
      } else if (processed % 20 === 0) {
        console.log(`[progress] ${processed}/${plans.length} sessions processed (inserted=${inserted})`);
      }
    }

    console.log('[done] execute summary:', JSON.stringify({
      sessions: plans.length,
      inserted,
      skipped,
      errors,
      conflictsSkipped: aggregate.conflicts,
    }));
    if (errors > 0) process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
