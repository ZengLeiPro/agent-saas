import { describe, expect, it, vi } from 'vitest';

import { changeStoredMemoryStatus, promoteStoredMemory } from './memoryLifecycle.js';

function fakePool(handler: (sql: string, args?: unknown[]) => Promise<{ rows: unknown[] }>) {
  const query = vi.fn(handler);
  const release = vi.fn();
  return {
    pool: { connect: vi.fn(async () => ({ query, release })) },
    query,
    release,
  };
}

describe('组织 Agent 记忆派生生命周期', () => {
  it('锁定源记录后才 promote，避免与撤源并发产生游离 active AgentMemory', async () => {
    const promoted = { memory_id: 'agent-memory-a', status: 'active' };
    const test = fakePool(async (sql) => {
      if (sql.includes('SELECT memory_id')) return { rows: [{ memory_id: 'source-a' }] };
      if (sql.includes('INSERT INTO')) return { rows: [promoted] };
      return { rows: [] };
    });

    await expect(
      promoteStoredMemory(test.pool as never, 'memories', {
        tenantId: 'tenant-a',
        sourceMemoryId: 'source-a',
        memoryId: 'agent-memory-a',
        promotedBy: 'admin-a',
        reason: '管理员确认',
        policyRevision: 3,
      }),
    ).resolves.toBe(promoted);

    const lockCall = test.query.mock.calls.find(([sql]) =>
      String(sql).includes('SELECT memory_id'),
    );
    expect(String(lockCall?.[0])).toContain('FOR UPDATE');
    expect(test.query).toHaveBeenCalledWith('COMMIT');
    expect(test.release).toHaveBeenCalledOnce();
  });

  it.each(['revoked', 'deleted'] as const)(
    '原子地把源记录和所有 active 派生记忆改为 %s，并保留 provenance',
    async (status) => {
      const sourceResult = { memory_id: 'source-a', status };
      const test = fakePool(async (sql) => {
        if (sql.includes('SELECT memory_scope')) {
          return { rows: [{ memory_scope: 'conversation', agent_id: 'agent-a' }] };
        }
        if (sql.includes('memory_id=$2') && sql.includes('RETURNING'))
          return { rows: [sourceResult] };
        return { rows: [] };
      });

      await expect(
        changeStoredMemoryStatus(test.pool as never, 'memories', {
          tenantId: 'tenant-a',
          memoryId: 'source-a',
          expectedVersion: 1,
          status,
        }),
      ).resolves.toBe(sourceResult);

      const cascade = test.query.mock.calls.find(
        ([sql]) =>
          String(sql).includes("memory_scope='agent'") &&
          String(sql).includes("provenance_json->>'sourceMemoryId'=$2"),
      );
      expect(cascade?.[1]).toEqual(['tenant-a', 'source-a', status, 'agent-a']);
      expect(String(cascade?.[0])).not.toContain('provenance_json=');
      expect(test.query).toHaveBeenCalledWith('COMMIT');
      expect(test.query).not.toHaveBeenCalledWith('ROLLBACK');
    },
  );

  it('任一派生失效写入失败时回滚源记录变更', async () => {
    const test = fakePool(async (sql) => {
      if (sql.includes('SELECT memory_scope')) {
        return { rows: [{ memory_scope: 'task_checkpoint', agent_id: 'agent-a' }] };
      }
      if (sql.includes('memory_id=$2') && sql.includes('RETURNING')) {
        return { rows: [{ memory_id: 'checkpoint-a', status: 'revoked' }] };
      }
      if (sql.includes("memory_scope='agent'")) throw new Error('database unavailable');
      return { rows: [] };
    });

    await expect(
      changeStoredMemoryStatus(test.pool as never, 'memories', {
        tenantId: 'tenant-a',
        memoryId: 'checkpoint-a',
        expectedVersion: 1,
        status: 'revoked',
      }),
    ).rejects.toThrow('database unavailable');

    expect(test.query).toHaveBeenCalledWith('ROLLBACK');
    expect(test.query).not.toHaveBeenCalledWith('COMMIT');
    expect(test.release).toHaveBeenCalledOnce();
  });
});
