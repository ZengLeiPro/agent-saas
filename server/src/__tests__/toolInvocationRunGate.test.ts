import { describe, expect, it, vi } from 'vitest';

import { invokeWithPgActiveRunGate } from '../runtime/pgToolInvocationRunGate.js';
import { InMemoryToolInvocationStore, type ToolInvocationRecord } from '../runtime/toolInvocationStore.js';

const record: ToolInvocationRecord = {
  invocationId: 'invocation-1',
  runId: 'run-1',
  sessionId: 'session-1',
  toolCallId: 'call-1',
  toolName: 'Shell',
  executionTarget: 'server-remote',
  status: 'running',
  startedAt: '2026-08-15T00:00:00.000Z',
  updatedAt: '2026-08-15T00:00:00.000Z',
  metadata: {},
};

describe('tool invocation run gate', () => {
  it('PG claim 的 COMMIT 失败时不调用工具，避免孤儿外部副作用', async () => {
    const invoke = vi.fn(async () => 'invoked');
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql === 'COMMIT') throw new Error('commit failed');
        if (sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('SELECT status')) return { rows: [{ status: 'running' }] };
        if (sql.includes('SELECT *')) return { rows: [record] };
        if (sql.includes('UPDATE')) return { rows: [{ ...record, metadata: { invokeClaimedAt: '2026-08-15T00:00:01.000Z' } }] };
        throw new Error(`unexpected query: ${sql}`);
      }),
      release: vi.fn(),
    };

    await expect(invokeWithPgActiveRunGate({
      pool: { connect: vi.fn(async () => client) } as any,
      runsTable: 'runtime_runs',
      toolInvocationsTable: 'runtime_tool_invocations',
      rowToRecord: (row: ToolInvocationRecord) => row,
    }, record.runId, record.invocationId, invoke)).rejects.toThrow('commit failed');

    expect(invoke).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('同一 invocation 只允许一个 worker 取得执行权', async () => {
    const store = new InMemoryToolInvocationStore();
    await store.start({
      invocationId: record.invocationId,
      runId: record.runId,
      sessionId: record.sessionId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      executionTarget: record.executionTarget,
    });
    const sideEffect = vi.fn(async () => 'invoked');
    const readRunning = async () => 'running';

    await expect(store.invokeWithActiveRunGate(
      record.runId, record.invocationId, sideEffect, readRunning,
    )).resolves.toMatchObject({ invoked: true, result: 'invoked' });
    await expect(store.invokeWithActiveRunGate(
      record.runId, record.invocationId, sideEffect, readRunning,
    )).resolves.toMatchObject({ invoked: false, reason: 'invocation_claimed' });

    expect(sideEffect).toHaveBeenCalledOnce();
    await expect(store.get(record.invocationId)).resolves.toMatchObject({
      metadata: { invokeClaimedAt: expect.any(String) },
    });
  });

  it('已 claim 的延迟 worker 在 winner 完成或取消后仍统一返回 invocation_claimed', async () => {
    const store = new InMemoryToolInvocationStore();
    for (const suffix of ['completed', 'cancelled']) {
      const invocationId = `inv-${suffix}`;
      await store.start({
        invocationId,
        runId: `run-${suffix}`,
        sessionId: `session-${suffix}`,
        toolCallId: `call-${suffix}`,
        toolName: 'Write',
        executionTarget: 'server-local',
      });
      await store.invokeWithActiveRunGate(
        `run-${suffix}`, invocationId, async () => 'winner', async () => 'running',
      );
      if (suffix === 'completed') {
        await store.complete(invocationId, 'completed');
      } else {
        await store.requestCancelOnce(invocationId, 'web_abort');
      }
      const sideEffect = vi.fn(async () => 'loser');
      await expect(store.invokeWithActiveRunGate(
        `run-${suffix}`, invocationId, sideEffect, async () => suffix,
      )).resolves.toMatchObject({ invoked: false, reason: 'invocation_claimed' });
      expect(sideEffect).not.toHaveBeenCalled();
    }
  });
});
