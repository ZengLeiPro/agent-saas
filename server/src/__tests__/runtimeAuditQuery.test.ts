import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { EventStoreRuntimeAuditQuery, toRuntimeAuditEntry } from '../runtime/auditQuery.js';
import { FileEventStore, getRuntimeEventLogPath } from '../runtime/fileEventStore.js';
import type { PlatformEvent } from '../runtime/types.js';

describe('EventStoreRuntimeAuditQuery', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  async function seedSession(): Promise<{ transcriptPath: string; sessionId: string }> {
    const cwd = await mkdtemp(join(tmpdir(), 'audit-query-'));
    cleanupDirs.add(cwd);
    const transcriptPath = join(cwd, 'session-A.jsonl');
    const eventStore = new FileEventStore(getRuntimeEventLogPath(transcriptPath));
    // 与 audit 无关的 noise，证明 query 会忽略非 tool_audit 事件
    await eventStore.append({
      type: 'run_started',
      runId: 'run-1',
      sessionId: 'session-A',
      model: 'gpt-5.5',
      channel: 'web',
    });
    await eventStore.append({
      type: 'assistant_message',
      runId: 'run-1',
      sessionId: 'session-A',
      content: 'hi',
    });
    // run-1: MemorySearch 自动放行 + Write 走人工审批
    await eventStore.append({
      type: 'tool_audit',
      runId: 'run-1',
      sessionId: 'session-A',
      toolCallId: 'call-mem',
      toolId: 'MemorySearch',
      toolName: 'MemorySearch',
      risk: 'safe',
      authorization: { approved: true, source: 'policy_auto' },
      executionTarget: 'server-local',
      status: 'success',
      durationMs: 12,
    });
    await eventStore.append({
      type: 'tool_audit',
      runId: 'run-1',
      sessionId: 'session-A',
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
      }],
    });
    // run-2: 同一 session 后续 run 的 Read，确保按 runId 过滤生效
    await eventStore.append({
      type: 'tool_audit',
      runId: 'run-2',
      sessionId: 'session-A',
      toolCallId: 'call-read',
      toolId: 'Read',
      toolName: 'Read',
      risk: 'safe',
      authorization: { approved: true, source: 'policy_auto' },
      executionTarget: 'server-local',
      status: 'error',
      durationMs: 7,
      error: 'ENOENT',
    });
    return { transcriptPath, sessionId: 'session-A' };
  }

  it('listBySessionId 返回顶层化字段，跳过非 tool_audit 事件', async () => {
    const { transcriptPath, sessionId } = await seedSession();
    const query = new EventStoreRuntimeAuditQuery(async () => transcriptPath);
    const entries = await query.listBySessionId(sessionId);
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
    // 顶层 error 字段在 error 条目上出现，在 success 条目上缺省
    expect(entries[0]!.error).toBeUndefined();
    expect(entries[2]!.error).toBe('ENOENT');
  });

  it('listByRunId 在 session 内按 runId 过滤', async () => {
    const { transcriptPath, sessionId } = await seedSession();
    const query = new EventStoreRuntimeAuditQuery(async () => transcriptPath);
    const run1 = await query.listByRunId(sessionId, 'run-1');
    expect(run1.map((e) => e.toolName)).toEqual(['MemorySearch', 'Write']);
    const run2 = await query.listByRunId(sessionId, 'run-2');
    expect(run2.map((e) => e.toolName)).toEqual(['Read']);
    const missing = await query.listByRunId(sessionId, 'run-nope');
    expect(missing).toEqual([]);
  });

  it('应用 since / limit / offset 选项', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'audit-query-paged-'));
    cleanupDirs.add(cwd);
    const transcriptPath = join(cwd, 'session-P.jsonl');
    const eventLogPath = getRuntimeEventLogPath(transcriptPath);
    const eventStore = new FileEventStore(eventLogPath);
    // 显式 timestamp 让 since 边界确定（绕过 FileEventStore 自动盖戳）
    const base = Date.UTC(2026, 5, 7, 9, 0, 0);
    const events: PlatformEvent[] = Array.from({ length: 5 }, (_, i) => ({
      id: `evt-${i}`,
      timestamp: new Date(base + i * 1000).toISOString(),
      type: 'tool_audit',
      runId: 'run-P',
      sessionId: 'session-P',
      toolCallId: `call-${i}`,
      toolId: 'MemorySearch',
      toolName: 'MemorySearch',
      risk: 'safe',
      authorization: { approved: true, source: 'policy_auto' },
      executionTarget: 'server-local',
      status: 'success',
      durationMs: 1,
    } as PlatformEvent));
    const { writeFile } = await import('fs/promises');
    await writeFile(eventLogPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const query = new EventStoreRuntimeAuditQuery(async () => transcriptPath);
    const sinceOnly = await query.listBySessionId('session-P', { since: new Date(base + 2000).toISOString() });
    expect(sinceOnly.map((e) => e.toolCallId)).toEqual(['call-2', 'call-3', 'call-4']);
    const limited = await query.listBySessionId('session-P', { limit: 2 });
    expect(limited.map((e) => e.toolCallId)).toEqual(['call-0', 'call-1']);
    const offset = await query.listBySessionId('session-P', { offset: 3 });
    expect(offset.map((e) => e.toolCallId)).toEqual(['call-3', 'call-4']);
    const combined = await query.listBySessionId('session-P', { offset: 1, limit: 2, since: new Date(base + 1000).toISOString() });
    // since 后剩 call-1..call-4；offset=1 → call-2..call-4；limit=2 → call-2/call-3
    expect(combined.map((e) => e.toolCallId)).toEqual(['call-2', 'call-3']);
  });

  it('summarize 给出 executionTarget / status / authorizationSource 分布', async () => {
    const { transcriptPath, sessionId } = await seedSession();
    const query = new EventStoreRuntimeAuditQuery(async () => transcriptPath);
    const summary = await query.summarize(sessionId);
    expect(summary).toEqual({
      total: 3,
      filteredTotal: 3,
      byExecutionTarget: { 'server-local': 2, 'server-container': 1 },
      byStatus: { success: 2, error: 1 },
      byAuthorizationSource: { policy_auto: 2, human_approval: 1 },
    });
  });

  it('transcript 不存在或没有 runtime-events 文件时返回空数组，不抛错', async () => {
    const missingResolver = new EventStoreRuntimeAuditQuery(async () => null);
    expect(await missingResolver.listBySessionId('session-X')).toEqual([]);
    expect(await missingResolver.listByRunId('session-X', 'run-X')).toEqual([]);

    const cwd = await mkdtemp(join(tmpdir(), 'audit-query-empty-'));
    cleanupDirs.add(cwd);
    const transcriptPath = join(cwd, 'absent.jsonl');
    const query = new EventStoreRuntimeAuditQuery(async () => transcriptPath);
    expect(await query.listBySessionId('absent')).toEqual([]);
    expect(await query.summarize('absent')).toEqual({
      total: 0,
      filteredTotal: 0,
      byExecutionTarget: {},
      byStatus: { success: 0, error: 0 },
      byAuthorizationSource: {},
    });
  });

  it('toRuntimeAuditEntry 直接转换 PlatformEvent.tool_audit', () => {
    const event = {
      id: 'evt-1',
      timestamp: '2026-06-07T08:00:00.000Z',
      type: 'tool_audit',
      runId: 'r',
      sessionId: 's',
      toolCallId: 'c',
      toolId: 'MemorySearch',
      toolName: 'MemorySearch',
      risk: 'safe',
      authorization: { approved: true, source: 'policy_auto' },
      executionTarget: 'server-local',
      status: 'success',
      durationMs: 9,
    } satisfies Extract<PlatformEvent, { type: 'tool_audit' }>;
    expect(toRuntimeAuditEntry(event)).toEqual({
      id: 'evt-1',
      timestamp: '2026-06-07T08:00:00.000Z',
      runId: 'r',
      sessionId: 's',
      // PR 10：event 没带 tenantId 时回退 'kaiyan'
      tenantId: 'kaiyan',
      toolCallId: 'c',
      toolId: 'MemorySearch',
      toolName: 'MemorySearch',
      risk: 'safe',
      authorization: { approved: true, source: 'policy_auto' },
      authorizationSource: 'policy_auto',
      executionTarget: 'server-local',
      status: 'success',
      durationMs: 9,
    });
  });
});
