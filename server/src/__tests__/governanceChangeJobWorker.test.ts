import { describe, expect, it, vi } from 'vitest';

import { GovernanceChangeJobWorker } from '../data/changeJobs/index.js';

const job = {
  tenantId: 'acme', jobId: 'job-1', status: 'pending', revision: 1,
};
const domains = [
  { domain: 'first', status: 'pending', revision: 1 },
  { domain: 'second', status: 'pending', revision: 1 },
];

describe('GovernanceChangeJobWorker', () => {
  it('claim 后逐域执行并持久化进度，全部成功才 complete', async () => {
    const calls: string[] = [];
    const store = {
      get: vi.fn().mockResolvedValue(job),
      claim: vi.fn().mockResolvedValue({ ...job, status: 'running', revision: 2 }),
      listDomains: vi.fn().mockResolvedValue(domains),
      updateDomain: vi.fn().mockResolvedValue({}),
      complete: vi.fn().mockResolvedValue({ ...job, status: 'succeeded', revision: 3 }),
      fail: vi.fn(),
    };
    const worker = new GovernanceChangeJobWorker({ store: store as never, workerId: 'worker-1' });
    await expect(worker.execute({
      tenantId: 'acme', jobId: 'job-1',
      handlers: {
        first: async () => { calls.push('first'); },
        second: async () => { calls.push('second'); },
      },
    })).resolves.toMatchObject({ status: 'succeeded' });
    expect(calls).toEqual(['first', 'second']);
    expect(store.updateDomain).toHaveBeenCalledTimes(2);
    expect(store.complete).toHaveBeenCalledWith('acme', 'job-1', 2, 'worker-1');
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('domain 失败记录失败计数并进入 retry_wait', async () => {
    const store = {
      get: vi.fn().mockResolvedValue(job),
      claim: vi.fn().mockResolvedValue({ ...job, status: 'running', revision: 2 }),
      listDomains: vi.fn().mockResolvedValue(domains),
      updateDomain: vi.fn().mockResolvedValue({}),
      complete: vi.fn(),
      fail: vi.fn().mockResolvedValue({ ...job, status: 'retry_wait', revision: 3 }),
    };
    const worker = new GovernanceChangeJobWorker({ store: store as never, workerId: 'worker-1', retryDelayMs: 1 });
    await expect(worker.execute({
      tenantId: 'acme', jobId: 'job-1',
      handlers: {
        first: async () => { throw new Error('REFERENCE_BLOCKED'); },
        second: async () => undefined,
      },
    })).resolves.toMatchObject({ status: 'retry_wait' });
    expect(store.updateDomain).toHaveBeenCalledWith(expect.objectContaining({
      domain: 'first', status: 'failed', failedCount: 1, errorCode: 'REFERENCE_BLOCKED',
    }));
    expect(store.fail).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 2, errorCode: 'REFERENCE_BLOCKED',
    }));
    expect(store.complete).not.toHaveBeenCalled();
  });
});
