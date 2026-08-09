import { describe, expect, it, vi } from 'vitest';

import { appendResolvedRunSnapshot } from '../runtime/rawRuntimeRunDispatch.js';

function input(result: Record<string, unknown>, append = vi.fn().mockResolvedValue(undefined)) {
  const warn = vi.fn();
  return {
    value: {
      config: {
        runPreflightService: { preflight: vi.fn().mockResolvedValue(result) },
        runResolutionSnapshotStore: { append },
        logger: { warn },
      },
      runId: 'run-1',
      session: { sessionId: 'session-1', userId: 'user-1', tenantId: 'tenant-a' },
      executionTarget: 'server',
      hands: [],
    } as never,
    append,
    warn,
  };
}

const snapshot = { snapshotId: 'snapshot-1', runId: 'run-1' };
const accessDecision = { reasonCode: 'ASSIGNMENT_REQUIRED' };

describe('Raw Runtime governance snapshot fail-closed', () => {
  it('shadow 模式 Snapshot 持久化失败只告警，不阻断运行', async () => {
    const append = vi.fn().mockRejectedValue(new Error('snapshot down'));
    const test = input({ proceed: true, enforcementMode: 'shadow', snapshot, accessDecision }, append);
    await expect(appendResolvedRunSnapshot(test.value)).resolves.toBeUndefined();
    expect(test.warn).toHaveBeenCalledWith(expect.stringContaining('snapshot unavailable'));
  });

  it('enforce 模式 Snapshot 持久化失败必须阻断运行', async () => {
    const append = vi.fn().mockRejectedValue(new Error('snapshot down'));
    const test = input({ proceed: true, enforcementMode: 'enforce', snapshot, accessDecision }, append);
    await expect(appendResolvedRunSnapshot(test.value)).rejects.toThrow('snapshot down');
  });

  it('enforce 访问拒绝时不得落 Snapshot，直接阻断运行', async () => {
    const test = input({ proceed: false, enforcementMode: 'enforce', snapshot, accessDecision });
    await expect(appendResolvedRunSnapshot(test.value)).rejects.toThrow('ASSIGNMENT_REQUIRED');
    expect(test.append).not.toHaveBeenCalled();
  });
});
