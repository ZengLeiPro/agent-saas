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
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('invokeClaimedByWorkerId'))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('PG gate 在同一事务发现 run worker 已切换时返回 lease lost 且绝不读取 claim 或执行', async () => {
    const invoke = vi.fn(async () => 'must-not-run');
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
        if (sql.includes('SELECT status, worker_id')) {
          return {
            rows: [{
              status: 'running', worker_id: 'worker-winner',
              lease_expires_at: new Date(Date.now() + 60_000), lease_is_valid: true,
            }],
          };
        }
        throw new Error(`unexpected query after lease loss: ${sql}`);
      }),
      release: vi.fn(),
    };

    await expect(invokeWithPgActiveRunGate({
      pool: { connect: vi.fn(async () => client) } as any,
      runsTable: 'runtime_runs',
      toolInvocationsTable: 'runtime_tool_invocations',
      rowToRecord: (row: ToolInvocationRecord) => row,
    }, record.runId, record.invocationId, invoke, 'worker-loser')).resolves.toEqual({
      invoked: false,
      reason: 'run_lease_lost',
      invocation: null,
      runStatus: 'running',
      runWorkerId: 'worker-winner',
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('lease_expires_at'))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('SELECT *'))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('PG gate 拒绝 worker 匹配但 lease 已过期的 run', async () => {
    const invoke = vi.fn(async () => 'must-not-run');
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
        if (sql.includes('SELECT status, worker_id')) {
          return {
            rows: [{
              status: 'running', worker_id: 'worker-current',
              lease_expires_at: new Date(Date.now() - 1_000), lease_is_valid: false,
            }],
          };
        }
        throw new Error(`unexpected query after expired lease: ${sql}`);
      }),
      release: vi.fn(),
    };

    await expect(invokeWithPgActiveRunGate({
      pool: { connect: vi.fn(async () => client) } as any,
      runsTable: 'runtime_runs',
      toolInvocationsTable: 'runtime_tool_invocations',
      rowToRecord: (row: ToolInvocationRecord) => row,
    }, record.runId, record.invocationId, invoke, 'worker-current')).resolves.toMatchObject({
      invoked: false,
      reason: 'run_lease_lost',
      runStatus: 'running',
      runWorkerId: 'worker-current',
    });

    expect(invoke).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('SELECT *'))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE'))).toBe(false);
  });

  it('InMemory gate 拒绝 worker 匹配但 lease 已过期或 run 不可执行的状态', async () => {
    const store = new InMemoryToolInvocationStore();
    await store.start({
      invocationId: 'invocation-expired-lease',
      runId: 'run-expired-lease',
      sessionId: 'session-expired-lease',
      toolCallId: 'call-expired-lease',
      toolName: 'Write',
      executionTarget: 'server-local',
    });
    const invoke = vi.fn(async () => 'must-not-run');

    for (const runState of [
      { status: 'running', workerId: 'worker-current', leaseExpiresAt: new Date(Date.now() - 1_000).toISOString() },
      { status: 'waiting_user', workerId: 'worker-current', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() },
    ]) {
      await expect(store.invokeWithActiveRunGate(
        'run-expired-lease',
        'invocation-expired-lease',
        invoke,
        async () => runState,
        'worker-current',
      )).resolves.toMatchObject({ invoked: false, reason: 'run_lease_lost' });
    }
    expect(invoke).not.toHaveBeenCalled();
    await expect(store.get('invocation-expired-lease')).resolves.toMatchObject({
      metadata: expect.not.objectContaining({ invokeClaimedAt: expect.anything() }),
    });
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
      metadata: { workerId: 'worker-winner' },
    });
    const sideEffect = vi.fn(async () => 'invoked');
    const readRunning = async () => 'running';

    await expect(store.invokeWithActiveRunGate(
      record.runId, record.invocationId, sideEffect, readRunning,
    )).resolves.toMatchObject({ invoked: true, result: 'invoked' });
    await store.start({
      invocationId: record.invocationId,
      runId: record.runId,
      sessionId: record.sessionId,
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      executionTarget: record.executionTarget,
      metadata: { workerId: 'worker-recovery' },
    });
    await expect(store.invokeWithActiveRunGate(
      record.runId, record.invocationId, sideEffect, readRunning,
    )).resolves.toMatchObject({ invoked: false, reason: 'invocation_claimed' });

    expect(sideEffect).toHaveBeenCalledOnce();
    await expect(store.get(record.invocationId)).resolves.toMatchObject({
      metadata: {
        workerId: 'worker-winner',
        invokeClaimedAt: expect.any(String),
        invokeClaimedByWorkerId: 'worker-winner',
      },
    });
  });

  it('claim owner 直接使用 expectedWorkerId，不从 invocation 的可变 workerId 猜测', async () => {
    const store = new InMemoryToolInvocationStore();
    await store.start({
      invocationId: 'invocation-explicit-owner',
      runId: 'run-explicit-owner',
      sessionId: 'session-explicit-owner',
      toolCallId: 'call-explicit-owner',
      toolName: 'Write',
      executionTarget: 'server-local',
      metadata: { workerId: 'stale-metadata-worker' },
    });

    await expect(store.invokeWithActiveRunGate(
      'run-explicit-owner',
      'invocation-explicit-owner',
      async () => 'invoked',
      async () => ({
        status: 'running',
        workerId: 'current-worker',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'current-worker',
    )).resolves.toMatchObject({ invoked: true, result: 'invoked' });
    await expect(store.get('invocation-explicit-owner')).resolves.toMatchObject({
      metadata: {
        workerId: 'stale-metadata-worker',
        invokeClaimedByWorkerId: 'current-worker',
      },
    });
  });

  it('旧 claim 缺 owner 时 recovery start 不把当前 worker 伪造成 claimant', async () => {
    const store = new InMemoryToolInvocationStore();
    await store.start({
      invocationId: 'invocation-owner-unknown',
      runId: 'run-owner-unknown',
      sessionId: 'session-owner-unknown',
      toolCallId: 'call-owner-unknown',
      toolName: 'Read',
      executionTarget: 'server-local',
    });
    await store.invokeWithActiveRunGate(
      'run-owner-unknown', 'invocation-owner-unknown', async () => 'claimed', async () => 'running',
    );
    await store.start({
      invocationId: 'invocation-owner-unknown',
      runId: 'run-owner-unknown',
      sessionId: 'session-owner-unknown',
      toolCallId: 'call-owner-unknown',
      toolName: 'Read',
      executionTarget: 'server-local',
      metadata: { workerId: 'worker-after-recovery' },
    });

    const recovered = await store.get('invocation-owner-unknown');
    expect(recovered?.metadata.invokeClaimedAt).toEqual(expect.any(String));
    expect(recovered?.metadata).not.toHaveProperty('workerId');
    expect(recovered?.metadata).not.toHaveProperty('invokeClaimedByWorkerId');
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
