/**
 * DuckDBRuntimeAuditQuery 测试
 *
 * 行为契约：与 EventStoreRuntimeAuditQuery 等价（同一份数据 → 同一份结果）。
 * 测试架构 = 同一份 seed 文件先经 AuditProjection 投影到内存 DuckDB，再用
 * DuckDBRuntimeAuditQuery 查询，断言：
 *   - listBySessionId / listByRunId / summarize 三方法的结果与 EventStore 实现一致
 *   - tickBeforeQuery=true 时新写入事件能在下一次 query 看到
 *
 * 注意：DuckDB 投影后丢失 jsonl 顺序——按 `timestamp ASC` 排序。seed 数据
 * 显式带 ascending timestamp，确保确定性。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import {
  createAuditProjection,
  RUNTIME_EVENTS_SUFFIX,
  type AuditProjection,
} from '../runtime/auditProjection.js';
import { DuckDBRuntimeAuditQuery } from '../runtime/auditQuery.js';
import type { PlatformEvent } from '../runtime/types.js';

const SESSION_A = '11111111-aaaa-4bbb-8ccc-dddddddddddd';

interface SeedToolAuditOverrides {
  id?: string;
  timestamp?: string;
  runId?: string;
  sessionId?: string;
  toolCallId?: string;
  toolId?: string;
  toolName?: string;
  risk?: Extract<PlatformEvent, { type: 'tool_audit' }>['risk'];
  approvalId?: string;
  authorization?: Extract<PlatformEvent, { type: 'tool_audit' }>['authorization'];
  executionTarget?: Extract<PlatformEvent, { type: 'tool_audit' }>['executionTarget'];
  status?: 'success' | 'error';
  durationMs?: number;
  executionInvocations?: Extract<PlatformEvent, { type: 'tool_audit' }>['executionInvocations'];
  error?: string;
}

function toolAuditLine(o: SeedToolAuditOverrides): string {
  const evt = {
    id: o.id ?? `evt-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: o.timestamp ?? '2026-06-07T10:00:00.000Z',
    type: 'tool_audit' as const,
    runId: o.runId ?? 'run-1',
    sessionId: o.sessionId ?? SESSION_A,
    toolCallId: o.toolCallId ?? 'call-1',
    toolId: o.toolId ?? 'MemorySearch',
    toolName: o.toolName ?? 'MemorySearch',
    risk: o.risk ?? 'safe',
    approvalId: o.approvalId,
    authorization: o.authorization ?? { approved: true, source: 'policy_auto' as const },
    executionTarget: o.executionTarget ?? 'server-local',
    status: o.status ?? 'success',
    durationMs: o.durationMs ?? 12,
    executionInvocations: o.executionInvocations,
    error: o.error,
  };
  return JSON.stringify(evt) + '\n';
}

describe('DuckDBRuntimeAuditQuery', () => {
  const cleanupDirs = new Set<string>();
  let instance: DuckDBInstance;
  let db: DuckDBConnection;
  let root: string;
  let projection: AuditProjection;
  let query: DuckDBRuntimeAuditQuery;

  beforeEach(async () => {
    instance = await DuckDBInstance.create(':memory:');
    db = await instance.connect();
    root = await mkdtemp(join(tmpdir(), 'duckdb-audit-q-'));
    cleanupDirs.add(root);
    projection = createAuditProjection({ db, root });
    await projection.initialize();
    query = new DuckDBRuntimeAuditQuery(db, projection);
  });

  afterEach(async () => {
    try { db.closeSync(); } catch { /* ignore */ }
    try { instance.closeSync(); } catch { /* ignore */ }
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  async function seedSessionA(): Promise<string> {
    const dir = join(root, 'proj-a');
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, `${SESSION_A}${RUNTIME_EVENTS_SUFFIX}`);
    const base = Date.UTC(2026, 5, 7, 9, 0, 0);
    await writeFile(filePath, [
      // 与 EventStoreRuntimeAuditQuery.test.ts 的 seedSession 结构相近，确保两 backend 行为对齐
      toolAuditLine({
        id: 'evt-mem',
        timestamp: new Date(base + 0).toISOString(),
        runId: 'run-1',
        toolCallId: 'call-mem',
        toolId: 'MemorySearch',
        toolName: 'MemorySearch',
        risk: 'safe',
        authorization: { approved: true, source: 'policy_auto' },
        executionTarget: 'server-local',
        status: 'success',
        durationMs: 12,
      }),
      toolAuditLine({
        id: 'evt-write',
        timestamp: new Date(base + 1000).toISOString(),
        runId: 'run-1',
        toolCallId: 'call-write',
        toolId: 'Write',
        toolName: 'Write',
        risk: 'workspace_write',
        approvalId: 'apv-1',
        authorization: { approved: true, source: 'human_approval', approvalId: 'apv-1' },
        executionTarget: 'server-container',
        status: 'success',
        durationMs: 240,
        executionInvocations: [{
          provider: 'server-container',
          operation: 'writeFile',
          containerName: 'sess-A',
          status: 'success',
          stdoutBytes: 0,
          stderrBytes: 0,
        }] as Extract<PlatformEvent, { type: 'tool_audit' }>['executionInvocations'],
      }),
      toolAuditLine({
        id: 'evt-read',
        timestamp: new Date(base + 2000).toISOString(),
        runId: 'run-2',
        toolCallId: 'call-read',
        toolId: 'Read',
        toolName: 'Read',
        risk: 'safe',
        authorization: { approved: true, source: 'policy_auto' },
        executionTarget: 'server-local',
        status: 'error',
        durationMs: 7,
        error: 'ENOENT',
      }),
    ].join(''));
    return filePath;
  }

  it('listBySessionId 返回顶层化字段（与 EventStore 行为一致）', async () => {
    await seedSessionA();
    const entries = await query.listBySessionId(SESSION_A);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => [e.toolName, e.runId, e.authorizationSource, e.executionTarget, e.status])).toEqual([
      ['MemorySearch', 'run-1', 'policy_auto', 'server-local', 'success'],
      ['Write', 'run-1', 'human_approval', 'server-container', 'success'],
      ['Read', 'run-2', 'policy_auto', 'server-local', 'error'],
    ]);
    const write = entries[1]!;
    expect(write.approvalId).toBe('apv-1');
    expect(write.executionInvocations?.[0]?.operation).toBe('writeFile');
    expect(write.authorization).toEqual({ approved: true, source: 'human_approval', approvalId: 'apv-1' });
    expect(entries[0]!.error).toBeUndefined();
    expect(entries[2]!.error).toBe('ENOENT');
  });

  it('listByRunId 在 session 内按 runId 过滤', async () => {
    await seedSessionA();
    const run1 = await query.listByRunId(SESSION_A, 'run-1');
    expect(run1.map((e) => e.toolName)).toEqual(['MemorySearch', 'Write']);
    const run2 = await query.listByRunId(SESSION_A, 'run-2');
    expect(run2.map((e) => e.toolName)).toEqual(['Read']);
    const missing = await query.listByRunId(SESSION_A, 'run-nope');
    expect(missing).toEqual([]);
  });

  it('应用 since / limit / offset 选项', async () => {
    await seedSessionA();
    const base = Date.UTC(2026, 5, 7, 9, 0, 0);

    const sinceOnly = await query.listBySessionId(SESSION_A, { since: new Date(base + 1000).toISOString() });
    expect(sinceOnly.map((e) => e.toolName)).toEqual(['Write', 'Read']);

    const limited = await query.listBySessionId(SESSION_A, { limit: 2 });
    expect(limited.map((e) => e.toolName)).toEqual(['MemorySearch', 'Write']);

    const offset = await query.listBySessionId(SESSION_A, { offset: 2 });
    expect(offset.map((e) => e.toolName)).toEqual(['Read']);

    const combined = await query.listBySessionId(SESSION_A, {
      offset: 1, limit: 1, since: new Date(base).toISOString(),
    });
    expect(combined.map((e) => e.toolName)).toEqual(['Write']);
  });

  it('summarize 给出 executionTarget / status / authorizationSource 分布', async () => {
    await seedSessionA();
    const summary = await query.summarize(SESSION_A);
    expect(summary).toEqual({
      total: 3,
      filteredTotal: 3,
      byExecutionTarget: { 'server-local': 2, 'server-container': 1 },
      byStatus: { success: 2, error: 1 },
      byAuthorizationSource: { policy_auto: 2, human_approval: 1 },
    });
  });

  it('summarize 的 filteredTotal 受 since 约束，total 仍是全 session', async () => {
    await seedSessionA();
    const base = Date.UTC(2026, 5, 7, 9, 0, 0);
    const summary = await query.summarize(SESSION_A, { since: new Date(base + 1000).toISOString() });
    expect(summary.total).toBe(3);
    expect(summary.filteredTotal).toBe(2);
    expect(summary.byExecutionTarget).toEqual({ 'server-container': 1, 'server-local': 1 });
  });

  it('session 不存在 → 空数组 / 空 summary', async () => {
    const entries = await query.listBySessionId('00000000-0000-4000-8000-000000000000');
    expect(entries).toEqual([]);
    const summary = await query.summarize('00000000-0000-4000-8000-000000000000');
    expect(summary).toEqual({
      total: 0,
      filteredTotal: 0,
      byExecutionTarget: {},
      byStatus: { success: 0, error: 0 },
      byAuthorizationSource: {},
    });
  });

  it('listByRunIdGlobal 跨 session 按 runId 返回所有条目', async () => {
    await seedSessionA();
    // 再 seed 一个 session B 共享 run-1（cross-session run 罕见但要 cover）
    const SESSION_B = '22222222-aaaa-4bbb-8ccc-dddddddddddd';
    const dirB = join(root, 'proj-b');
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirB, `${SESSION_B}${RUNTIME_EVENTS_SUFFIX}`),
      toolAuditLine({
        id: 'evt-b-1',
        timestamp: '2026-06-07T09:00:05.000Z',
        sessionId: SESSION_B,
        runId: 'run-1',
        toolCallId: 'call-b-1',
        toolName: 'MemorySearch',
      }),
    );

    const r1 = await query.listByRunIdGlobal('run-1');
    expect(r1).toHaveLength(3);  // session A 两条 + session B 一条
    expect(r1.map((e) => e.sessionId).sort()).toEqual([SESSION_A, SESSION_A, SESSION_B].sort());

    const r2 = await query.listByRunIdGlobal('run-2');
    expect(r2).toHaveLength(1);
    expect(r2[0]!.sessionId).toBe(SESSION_A);

    const empty = await query.listByRunIdGlobal('run-nope');
    expect(empty).toEqual([]);
  });

  it('summarizeByRunIdGlobal 返回 sessionIds + 分布', async () => {
    await seedSessionA();
    const SESSION_B = '22222222-aaaa-4bbb-8ccc-dddddddddddd';
    const dirB = join(root, 'proj-b');
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirB, `${SESSION_B}${RUNTIME_EVENTS_SUFFIX}`),
      toolAuditLine({
        id: 'evt-b-1',
        timestamp: '2026-06-07T09:00:05.000Z',
        sessionId: SESSION_B,
        runId: 'run-1',
        toolCallId: 'call-b-1',
        toolName: 'Write',
        toolId: 'Write',
        risk: 'workspace_write',
        approvalId: 'apv-b',
        authorization: { approved: true, source: 'human_approval', approvalId: 'apv-b' },
        executionTarget: 'server-container',
        durationMs: 30,
      }),
    );

    const summary = await query.summarizeByRunIdGlobal('run-1');
    expect(summary.total).toBe(3);
    expect(summary.filteredTotal).toBe(3);
    expect(summary.sessionIds.sort()).toEqual([SESSION_A, SESSION_B].sort());
    expect(summary.byExecutionTarget).toEqual({ 'server-local': 1, 'server-container': 2 });
    expect(summary.byStatus).toEqual({ success: 3, error: 0 });
    expect(summary.byAuthorizationSource).toEqual({ policy_auto: 1, human_approval: 2 });
  });

  it('tickBeforeQuery=true（默认）：后写入的事件下次 query 能看到', async () => {
    const filePath = await seedSessionA();
    // 第一次 query 触发 tick，3 条入库
    expect(await query.listBySessionId(SESSION_A)).toHaveLength(3);

    // 在 server 之外追加新事件 → 不手动 tick，依赖 query 自动 tick
    await appendFile(filePath, toolAuditLine({
      id: 'evt-late',
      timestamp: '2026-06-07T11:00:00.000Z',
      runId: 'run-3',
      toolCallId: 'call-late',
      toolName: 'MemorySearch',
      toolId: 'MemorySearch',
    }));

    const entries = await query.listBySessionId(SESSION_A);
    expect(entries.map((e) => e.id)).toContain('evt-late');
    expect(entries).toHaveLength(4);
  });
});
