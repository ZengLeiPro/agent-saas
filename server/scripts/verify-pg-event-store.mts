/**
 * Verify PgEventStore without mutating config.json or touching the 3200 server.
 *
 * Coverage:
 * - boot a temporary local Postgres container unless --connection-string is set
 * - PgEventStore init / appendBatch / list / listPage
 * - concurrent appends keep contiguous session-local sequence
 * - EventBackedApprovalStore state survives PgEventStore re-open
 * - loadRawRuntimeWakeState restores pending approval from PG-backed event log
 * - PgRuntimeAuditQuery list/summarize semantics + cross-session runId queries
 * - PgSessionLock advisory lock mutual exclusion + release semantics
 *
 * Usage:
 *   pnpm -C server run verify:pg-event-store
 *   pnpm -C server run verify:pg-event-store -- --connection-string postgresql://...
 */
import { randomUUID } from 'node:crypto';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';

import type { ExecutionTargetKind, ToolRisk } from '../src/agent/toolRuntime.js';
import { EventBackedApprovalStore } from '../src/runtime/approvalStore.js';
import { PgRuntimeAuditQuery } from '../src/runtime/pgAuditQuery.js';
import { PgEventStore } from '../src/runtime/pgEventStore.js';
import { PgSessionLock, sessionIdToLockKey } from '../src/runtime/pgSessionLock.js';
import { loadRawRuntimeWakeState } from '../src/runtime/rawRuntimeRunDispatch.js';
import type { RuntimeSessionRecord, SessionCatalog } from '../src/runtime/sessionCatalog.js';
import type { PlatformEvent, PlatformEventInput } from '../src/runtime/types.js';

const execFile = promisify(execFileCb);
const { Client, Pool } = pg;

const POSTGRES_IMAGE = 'postgres:16-alpine';

type PgPool = InstanceType<typeof Pool>;

function createPool(connectionString: string): PgPool {
  const pool = new Pool({ connectionString });
  pool.on('error', (err) => {
    console.warn(`[warn] pg pool idle client error: ${err instanceof Error ? err.message : String(err)}`);
  });
  return pool;
}

class MemorySessionCatalog implements SessionCatalog {
  private readonly records = new Map<string, RuntimeSessionRecord>();

  async upsert(record: RuntimeSessionRecord): Promise<void> {
    this.records.set(record.sessionId, record);
  }

  async get(sessionId: string): Promise<RuntimeSessionRecord | null> {
    return this.records.get(sessionId) ?? null;
  }

  async markStatus(sessionId: string, status: RuntimeSessionRecord['status']): Promise<void> {
    const existing = this.records.get(sessionId);
    if (!existing) return;
    this.records.set(sessionId, { ...existing, status, updatedAt: new Date().toISOString() });
  }

  async findTranscriptPath(sessionId: string): Promise<string | null> {
    return this.records.get(sessionId)?.transcriptPath ?? null;
  }
}

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0) return process.argv[idx + 1];
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(description: string, predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function makeEvent(sessionId: string, runId: string, index: number): PlatformEventInput {
  return {
    type: 'user_message',
    runId,
    sessionId,
    content: `message-${index}`,
  };
}

function makeStreamDelta(sessionId: string, runId: string, index: number): PlatformEventInput {
  return {
    type: 'tool_output_delta',
    runId,
    sessionId,
    invocationId: `${runId}:invocation`,
    toolCallId: `${runId}:tool`,
    channel: 'stdout',
    content: `stdout-${index}`,
  };
}

async function dockerImageExists(image: string): Promise<boolean> {
  try {
    await execFile('docker', ['image', 'inspect', image], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function startPostgresContainer(): Promise<{ connectionString: string; cleanup: () => Promise<void> }> {
  assert(await dockerImageExists(POSTGRES_IMAGE), `Docker image missing: ${POSTGRES_IMAGE}`);

  const name = `agent-runtime-pg-verify-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const password = `pw-${randomUUID()}`;
  const database = 'runtime_verify';
  const run = await execFile('docker', [
    'run',
    '--detach',
    '--rm',
    '--pull=never',
    '--name',
    name,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    `POSTGRES_DB=${database}`,
    '-p',
    '127.0.0.1::5432',
    POSTGRES_IMAGE,
  ], { timeout: 30_000 });
  const containerId = run.stdout.trim();
  assert(containerId, 'docker run did not return a container id');

  const cleanup = async (): Promise<void> => {
    await execFile('docker', ['stop', containerId], { timeout: 30_000 }).catch(() => undefined);
  };

  try {
    const portOutput = await execFile('docker', ['port', containerId, '5432/tcp'], { timeout: 10_000 });
    const mapped = portOutput.stdout.trim().split('\n')[0] ?? '';
    const port = mapped.match(/:(\d+)$/)?.[1];
    assert(port, `could not parse mapped postgres port: ${mapped}`);
    const connectionString = `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
    await waitForPostgres(connectionString, 45_000);
    return { connectionString, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

async function waitForPostgres(connectionString: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const pool = createPool(connectionString);
    try {
      await pool.query('SELECT 1');
      await pool.end();
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await pool.end().catch(() => undefined);
      await sleep(500);
    }
  }
  throw new Error(`postgres did not become ready: ${lastError}`);
}

async function assertStoredSequences(
  connectionString: string,
  tablePrefix: string,
  sessionId: string,
  expectedCount: number,
): Promise<void> {
  const pool = createPool(connectionString);
  try {
    const result = await pool.query<{ session_sequence: string }>(
      `SELECT session_sequence
       FROM ${tablePrefix}_events
       WHERE session_id = $1
       ORDER BY session_sequence ASC`,
      [sessionId],
    );
    const sequences = result.rows.map((row) => Number(row.session_sequence));
    assert(sequences.length === expectedCount, `expected ${expectedCount} events, got ${sequences.length}`);
    for (let i = 0; i < sequences.length; i += 1) {
      assert(sequences[i] === i + 1, `non-contiguous session sequence at index=${i}: ${sequences.join(',')}`);
    }
  } finally {
    await pool.end();
  }
}

async function assertTablePrefixCleanable(connectionString: string, tablePrefix: string): Promise<void> {
  const pool = createPool(connectionString);
  try {
    await pool.query(`DROP TABLE IF EXISTS ${tablePrefix}_events`);
    await pool.query(`DROP TABLE IF EXISTS ${tablePrefix}_event_cursors`);
  } finally {
    await pool.end();
  }
}

async function verifyStreamNotifyCoalescing(
  connectionString: string,
  tablePrefix: string,
  store: PgEventStore,
): Promise<{
  sessionId: string;
  totalEvents: number;
  batches: number;
  notifications: number;
  replayLatencyMs: number;
}> {
  const sessionId = `session-stream-${randomUUID()}`;
  const runId = `run-stream-${randomUUID()}`;
  const batches = 20;
  const eventsPerBatch = 25;
  const totalEvents = batches * eventsPerBatch;
  const channel = `${tablePrefix}_events_notify`;
  const notifyClient = new Client({ connectionString });
  let notifications = 0;
  notifyClient.on('notification', (message) => {
    if (message.channel === channel) notifications += 1;
  });
  notifyClient.on('error', (err) => {
    console.warn(`[warn] raw pg notify listener error: ${err instanceof Error ? err.message : String(err)}`);
  });

  const received: PlatformEvent[] = [];
  let unsubscribe: (() => Promise<void>) | undefined;
  try {
    await notifyClient.connect();
    await notifyClient.query(`LISTEN ${channel}`);
    unsubscribe = await store.subscribeAppended((event) => {
      if (event.sessionId === sessionId) received.push(event);
    });

    const startedAt = Date.now();
    for (let batchIndex = 0; batchIndex < batches; batchIndex += 1) {
      const batch = Array.from({ length: eventsPerBatch }, (_, eventIndex) => (
        makeStreamDelta(sessionId, runId, batchIndex * eventsPerBatch + eventIndex)
      ));
      await store.appendBatch?.(batch);
    }

    await waitUntil(
      `stream notify replay (${totalEvents} events / ${batches} notifications)`,
      () => received.length >= totalEvents && notifications >= batches,
      10_000,
    );
    const replayLatencyMs = Date.now() - startedAt;
    assert(
      notifications === batches,
      `expected one pg_notify per appendBatch (${batches}), got ${notifications}`,
    );
    assert(received.length === totalEvents, `expected ${totalEvents} replayed stream events, got ${received.length}`);
    assert(
      received.every((event, index) => event.type === 'tool_output_delta' && event.content === `stdout-${index}`),
      'stream notify replay order/content mismatch',
    );
    return { sessionId, totalEvents, batches, notifications, replayLatencyMs };
  } finally {
    if (unsubscribe) await unsubscribe();
    await notifyClient.query(`UNLISTEN ${channel}`).catch(() => undefined);
    await notifyClient.end().catch(() => undefined);
  }
}

async function runVerify(connectionString: string): Promise<void> {
  const tablePrefix = `verify_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const sessionId = `session-${randomUUID()}`;
  const runId = `run-${randomUUID()}`;

  const store = new PgEventStore({ connectionString, tablePrefix });
  await store.init();

  console.log(`[step] PgEventStore appendBatch/list/listPage: tablePrefix=${tablePrefix}`);
  await store.appendBatch?.([
    { type: 'run_started', runId, sessionId, model: 'gpt-5.5', channel: 'verify' },
    makeEvent(sessionId, runId, 1),
    { type: 'assistant_message', runId, sessionId, content: 'assistant-1' },
  ]);

  const listed = await store.list(sessionId);
  assert(listed.map((event) => event.type).join(',') === 'run_started,user_message,assistant_message', 'list order mismatch');

  const firstPage = await store.listPage?.(sessionId, { limit: 2 });
  assert(firstPage?.events.length === 2, 'first page length mismatch');
  assert(firstPage.hasMore === true, 'first page hasMore mismatch');
  const secondPage = await store.listPage?.(sessionId, { afterCursor: firstPage.nextCursor, limit: 2 });
  assert(secondPage?.events.length === 1, 'second page length mismatch');
  assert(secondPage.hasMore === false, 'second page hasMore mismatch');

  console.log('[step] PgEventStore concurrent append sequence');
  const batches = Array.from({ length: 8 }, (_, batchIndex) => (
    Array.from({ length: 3 }, (_, eventIndex) => makeEvent(sessionId, runId, 100 + batchIndex * 3 + eventIndex))
  ));
  await Promise.all(batches.map((batch) => store.appendBatch?.(batch)));
  await assertStoredSequences(connectionString, tablePrefix, sessionId, 27);

  console.log('[step] EventBackedApprovalStore persistence across PgEventStore reopen');
  const approvalStore = new EventBackedApprovalStore(store, sessionId);
  const approval = await approvalStore.create({
    sessionId,
    runId,
    toolCallId: 'call-write',
    toolId: 'Write',
    toolName: 'Write',
    displayName: 'Write File',
    executionTarget: 'server-container',
    input: { path: 'assets/verify.txt', content: 'PG_OK' },
  });
  const [resolvedA, resolvedB] = await Promise.all([
    approvalStore.resolvePending(approval.id, 'approved', 'ok'),
    approvalStore.resolvePending(approval.id, 'approved', 'duplicate'),
  ]);
  assert([resolvedA, resolvedB].filter(Boolean).length === 1, 'duplicate resolvePending was not idempotent in-process');
  await store.close();

  const reopened = new PgEventStore({ connectionString, tablePrefix });
  await reopened.init();
  const reopenedApprovals = new EventBackedApprovalStore(reopened, sessionId);
  assert((await reopenedApprovals.get(approval.id))?.status === 'approved', 'approval did not survive PgEventStore reopen');

  console.log('[step] loadRawRuntimeWakeState from PG-backed event log');
  const wakeSessionId = `session-wake-${randomUUID()}`;
  const wakeRunId = `run-wake-${randomUUID()}`;
  const catalog = new MemorySessionCatalog();
  await catalog.upsert({
    sessionId: wakeSessionId,
    userId: 'admin-1',
    username: 'admin',
    channel: 'web',
    cwd: join(tmpdir(), 'agent-runtime-pg-verify'),
    transcriptPath: join(tmpdir(), `${wakeSessionId}.jsonl`),
    modelRef: 'openai-agents/gpt55',
    executionTarget: 'server-container',
    workspaceId: wakeSessionId,
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await reopened.append({
    type: 'assistant_tool_calls',
    runId: wakeRunId,
    sessionId: wakeSessionId,
    content: '',
    toolCalls: [{
      id: 'call-wake-write',
      name: 'Write',
      arguments: JSON.stringify({ path: 'a.txt', content: 'A' }),
    }],
  });
  const wakeApproval = await new EventBackedApprovalStore(reopened, wakeSessionId).create({
    sessionId: wakeSessionId,
    runId: wakeRunId,
    toolCallId: 'call-wake-write',
    toolId: 'Write',
    toolName: 'Write',
    executionTarget: 'server-container',
    input: { path: 'a.txt', content: 'A' },
  });
  const wakeState = await loadRawRuntimeWakeState({
    agentCwd: join(tmpdir(), 'agent-runtime-pg-verify'),
    sessionCatalog: catalog,
    eventStoreFactory: () => reopened,
  }, wakeSessionId);
  assert(
    wakeState?.replayState.pendingApprovals.some((item) => item.approval?.id === wakeApproval.id),
    'wake state missing pending approval',
  );
  assert(wakeState.session.executionTarget === 'server-container', 'wake state executionTarget mismatch');

  console.log('[step] PgRuntimeAuditQuery list/summarize + cross-session runId');
  const auditSessionA = `session-audit-a-${randomUUID()}`;
  const auditSessionB = `session-audit-b-${randomUUID()}`;
  const runX = `run-x-${randomUUID()}`;
  const runY = `run-y-${randomUUID()}`;

  // 4 个 tool_audit：sessionA 2 个、sessionB 2 个；runX 跨两个 session。
  // append 顺序即预期 list 顺序（ORDER BY timestamp ASC, global_sequence ASC）。
  const auditEvents: PlatformEventInput[] = [
    buildAuditEvent(auditSessionA, runX, 'call-a1', 'Read', 'safe', 'server-local', 'policy_auto', 'success', 12),
    buildAuditEvent(auditSessionA, runY, 'call-a2', 'Write', 'workspace_write', 'server-container', 'human_approval', 'success', 28, 'appr-1'),
    buildAuditEvent(auditSessionB, runX, 'call-b1', 'Shell', 'dangerous', 'server-container', 'policy_auto', 'error', 7),
    buildAuditEvent(auditSessionB, runY, 'call-b2', 'Read', 'safe', 'server-remote', 'policy_auto', 'success', 3),
  ];
  for (const event of auditEvents) {
    await reopened.append(event);
  }

  const auditQuery = new PgRuntimeAuditQuery({ pool: reopened.pool, eventsTable: reopened.eventsTable });

  // listBySessionId：仅 sessionA 的 2 条，按 append 顺序
  const aEntries = await auditQuery.listBySessionId(auditSessionA);
  assert(aEntries.length === 2, `expected 2 audit entries for sessionA, got ${aEntries.length}`);
  assert(
    aEntries.map((e) => e.toolName).join(',') === 'Read,Write',
    `sessionA tool order mismatch: ${aEntries.map((e) => e.toolName).join(',')}`,
  );

  // listByRunId：sessionA + runX 只有 Read
  const runXInA = await auditQuery.listByRunId(auditSessionA, runX);
  assert(
    runXInA.length === 1 && runXInA[0]?.toolName === 'Read',
    `runX-in-sessionA mismatch: ${JSON.stringify(runXInA.map((e) => e.toolName))}`,
  );

  // listByRunIdGlobal：runX 跨 2 个 session
  assert(auditQuery.listByRunIdGlobal, 'listByRunIdGlobal must be implemented');
  const runXGlobal = await auditQuery.listByRunIdGlobal(runX);
  assert(runXGlobal.length === 2, `expected runX global=2, got ${runXGlobal.length}`);
  assert(
    new Set(runXGlobal.map((e) => e.sessionId)).size === 2,
    'runX global should span 2 sessions',
  );

  // summarize（单 session）
  const summaryA = await auditQuery.summarize(auditSessionA);
  assert(summaryA.total === 2, `summary.total mismatch: ${summaryA.total}`);
  assert(summaryA.filteredTotal === 2, `summary.filteredTotal mismatch: ${summaryA.filteredTotal}`);
  assert(summaryA.byStatus.success === 2 && summaryA.byStatus.error === 0, 'summaryA.byStatus mismatch');
  assert(
    summaryA.byExecutionTarget['server-local'] === 1
    && summaryA.byExecutionTarget['server-container'] === 1,
    `summaryA.byExecutionTarget mismatch: ${JSON.stringify(summaryA.byExecutionTarget)}`,
  );
  assert(
    summaryA.byAuthorizationSource.policy_auto === 1
    && summaryA.byAuthorizationSource.human_approval === 1,
    `summaryA.byAuthorizationSource mismatch: ${JSON.stringify(summaryA.byAuthorizationSource)}`,
  );

  // summarizeByRunIdGlobal：runX 跨 session，含 success + error 分布
  assert(auditQuery.summarizeByRunIdGlobal, 'summarizeByRunIdGlobal must be implemented');
  const runXSummary = await auditQuery.summarizeByRunIdGlobal(runX);
  assert(
    runXSummary.sessionIds.slice().sort().join(',') === [auditSessionA, auditSessionB].slice().sort().join(','),
    `runX sessionIds mismatch: ${JSON.stringify(runXSummary.sessionIds)}`,
  );
  assert(
    runXSummary.byStatus.success === 1 && runXSummary.byStatus.error === 1,
    `runX byStatus mismatch: ${JSON.stringify(runXSummary.byStatus)}`,
  );

  // since 过滤：未来时间应当返回空
  const sinceFuture = new Date(Date.now() + 60_000).toISOString();
  const futureEntries = await auditQuery.listBySessionId(auditSessionA, { since: sinceFuture });
  assert(futureEntries.length === 0, `since future should return empty, got ${futureEntries.length}`);
  const summaryAFuture = await auditQuery.summarize(auditSessionA, { since: sinceFuture });
  assert(
    summaryAFuture.total === 2 && summaryAFuture.filteredTotal === 0,
    `summaryAFuture total/filteredTotal mismatch: ${JSON.stringify(summaryAFuture)}`,
  );

  // limit / offset
  const limited = await auditQuery.listBySessionId(auditSessionA, { limit: 1 });
  assert(limited.length === 1 && limited[0]?.toolName === 'Read', `limit=1 mismatch`);
  const skipped = await auditQuery.listBySessionId(auditSessionA, { offset: 1 });
  assert(
    skipped.length === 1 && skipped[0]?.toolName === 'Write',
    `offset=1 mismatch: ${JSON.stringify(skipped.map((e) => e.toolName))}`,
  );

  console.log('[step] PgEventStore stream notify coalescing under burst load');
  const streamNotify = await verifyStreamNotifyCoalescing(connectionString, tablePrefix, reopened);
  console.log(`[step] stream notify replay: events=${streamNotify.totalEvents} batches=${streamNotify.batches} notifications=${streamNotify.notifications} latencyMs=${streamNotify.replayLatencyMs}`);

  console.log('[step] PgSessionLock mutual exclusion + release');
  const lockSessionA = `lock-session-a-${randomUUID()}`;
  const lockSessionB = `lock-session-b-${randomUUID()}`;
  const lockA = new PgSessionLock({ pool: reopened.pool });

  // 1) 不同 sessionId 应当互不干扰
  const handleA = await lockA.tryAcquire(lockSessionA);
  assert(handleA !== null, 'expected first tryAcquire(sessionA) to succeed');
  const handleB = await lockA.tryAcquire(lockSessionB);
  assert(handleB !== null, 'expected tryAcquire(sessionB) to succeed (different session)');

  // 2) 同 sessionId 第二次 tryAcquire 应当被拒
  const handleADup = await lockA.tryAcquire(lockSessionA);
  assert(handleADup === null, 'expected duplicate tryAcquire(sessionA) to return null');

  // 3) sessionA release 之后再 tryAcquire 应当能拿到
  await handleA!.release();
  assert(handleA!.released, 'handleA.released should be true after release()');
  const handleARe = await lockA.tryAcquire(lockSessionA);
  assert(handleARe !== null, 'expected tryAcquire(sessionA) to succeed after release');

  // 4) release 幂等：第 2 次 release 不抛
  await handleARe!.release();
  await handleARe!.release();

  // 5) key 与独立 hash 函数一致（便于跨语言/跨 brain 校验未来）
  assert(handleB!.key === sessionIdToLockKey(lockSessionB), 'handle.key mismatches sessionIdToLockKey()');
  await handleB!.release();

  // 6) 跨独立 PgSessionLock 实例的互斥（模拟两个 brain 进程共享 pool 的情景）
  const lockX = new PgSessionLock({ pool: reopened.pool });
  const lockY = new PgSessionLock({ pool: reopened.pool });
  const crossSession = `lock-cross-${randomUUID()}`;
  const handleX = await lockX.tryAcquire(crossSession);
  assert(handleX !== null, 'expected lockX to acquire crossSession');
  const handleYBlocked = await lockY.tryAcquire(crossSession);
  assert(handleYBlocked === null, 'lockY should NOT acquire while lockX holds it');
  await handleX!.release();
  const handleYTakeover = await lockY.tryAcquire(crossSession);
  assert(handleYTakeover !== null, 'lockY should acquire after lockX releases');
  await handleYTakeover!.release();

  await reopened.close();
  await assertTablePrefixCleanable(connectionString, tablePrefix);

  console.log('[PASS] pg event store verify passed');
  console.log(JSON.stringify({
    tablePrefix,
    sessionId,
    wakeSessionId,
    eventCount: 27,
    approvalId: approval.id,
    wakeApprovalId: wakeApproval.id,
    auditSessionA,
    auditSessionB,
    runXGlobalCount: runXGlobal.length,
    streamNotify,
  }, null, 2));
}

function buildAuditEvent(
  sessionId: string,
  runId: string,
  toolCallId: string,
  toolName: string,
  risk: ToolRisk,
  executionTarget: ExecutionTargetKind,
  source: 'policy_auto' | 'human_approval' | 'legacy_adapter',
  status: 'success' | 'error',
  durationMs: number,
  approvalId?: string,
): PlatformEventInput {
  return {
    type: 'tool_audit',
    runId,
    sessionId,
    toolCallId,
    toolId: toolName,
    toolName,
    risk,
    ...(approvalId ? { approvalId } : {}),
    authorization: {
      approved: status === 'success',
      source,
      ...(approvalId ? { approvalId } : {}),
    },
    executionTarget,
    status,
    durationMs,
  } satisfies PlatformEventInput;
}

async function main(): Promise<void> {
  const providedConnectionString = argValue('--connection-string');
  const pgRuntime = providedConnectionString
    ? { connectionString: providedConnectionString, cleanup: async () => undefined }
    : await startPostgresContainer();

  try {
    await runVerify(pgRuntime.connectionString);
  } finally {
    await pgRuntime.cleanup();
  }
}

main().catch((err) => {
  console.error('[FAIL]', err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
