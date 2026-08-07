import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GroupStore } from '../data/groups/store.js';

const cleanupPaths: string[] = [];

async function createStores(): Promise<{ first: GroupStore; second: GroupStore }> {
  const root = await mkdtemp(join(tmpdir(), 'groups-cross-process-'));
  cleanupPaths.push(root);
  const filePath = join(root, 'groups.json');
  return {
    first: new GroupStore(filePath),
    second: new GroupStore(filePath),
  };
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('GroupStore cross-process consistency', () => {
  it('refreshes read snapshots after another process writes', async () => {
    const { first: webStore, second: workerStore } = await createStores();

    await workerStore.create({
      name: '每日报告',
      kind: 'cron',
      cronJobId: 'job-1',
      sessionIds: ['session-1'],
      userId: 'user-1',
    });

    expect(webStore.listByUserId('user-1')).toEqual([
      expect.objectContaining({
        id: 'cron:job-1',
        sessionIds: ['session-1'],
      }),
    ]);
  });

  it('serializes concurrent mutations without losing either process update', async () => {
    const { first, second } = await createStores();

    await Promise.all([
      first.create({ name: '分组 A', userId: 'user-1' }),
      second.create({ name: '分组 B', userId: 'user-1' }),
    ]);

    expect(first.listByUserId('user-1').map(group => group.name).sort()).toEqual([
      '分组 A',
      '分组 B',
    ]);
  });

  it('atomically upserts one cron group when two instances add sessions', async () => {
    const { first, second } = await createStores();

    await Promise.all([
      first.addCronSession({
        jobId: 'job-1',
        jobName: '每日报告',
        sessionId: 'session-1',
        owner: 'user-1',
      }),
      second.addCronSession({
        jobId: 'job-1',
        jobName: '每日报告',
        sessionId: 'session-2',
        owner: 'user-1',
      }),
    ]);

    const groups = first.listByUserId('user-1');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: 'cron:job-1',
      cronJobId: 'job-1',
    });
    expect([...groups[0].sessionIds].sort()).toEqual(['session-1', 'session-2']);
  });
});
