import { describe, expect, it } from 'vitest';

import { transferCronJobOwner } from '../cron/serviceUtils.js';
import type { CronJob } from '../cron/types.js';

describe('transferCronJobOwner', () => {
  it('转移 owner 时清除原企业专家绑定', () => {
    const job: CronJob = {
      id: 'job-a',
      name: '每日任务',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 9 * * *' },
      payload: { kind: 'agentTurn', message: '执行任务' },
      owner: 'user-a',
      ownerName: 'alice',
      orgAgentId: 'agent-a',
      createdAtMs: 1,
      updatedAtMs: 1,
      state: { nextRunAtMs: 10 },
    };

    expect(transferCronJobOwner([job], {
      id: job.id,
      expectedOwner: 'user-a',
      owner: 'user-b',
      ownerName: 'bob',
      nowMs: 2,
    })).toEqual({ changed: true, value: job.id });
    expect(job).toMatchObject({ owner: 'user-b', ownerName: 'bob', enabled: false });
    expect(job.orgAgentId).toBeUndefined();
  });
});
