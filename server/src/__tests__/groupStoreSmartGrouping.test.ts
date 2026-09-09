import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GroupStore, SmartGroupingConflictError } from '../data/groups/index.js';

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('GroupStore.applySmartGrouping', () => {
  it('一次写入重排普通会话且保持系统分组不变', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'smart-groups-'));
    cleanup.push(dir);
    const store = new GroupStore(join(dir, 'groups.json'));
    await store.create({ userId: 'u1', name: '旧组', sessionIds: ['s1', 's2'] });
    await store.create({
      userId: 'u1',
      name: '定时任务',
      kind: 'cron',
      cronJobId: 'c1',
      sessionIds: ['cron-s'],
    });
    const fingerprint = store.getUserSnapshotFingerprint('u1');

    await store.applySmartGrouping({
      userId: 'u1',
      expectedFingerprint: fingerprint,
      targetSessionIds: ['s1', 's2'],
      groups: [{ name: '客户项目', sessionIds: ['s1', 's2'] }],
    });

    expect(store.listByUserId('u1').find((group) => group.name === '旧组')?.sessionIds).toEqual([]);
    expect(store.listByUserId('u1').find((group) => group.name === '客户项目')?.sessionIds).toEqual(
      ['s1', 's2'],
    );
    expect(store.findByCronJobId('c1')?.sessionIds).toEqual(['cron-s']);
  });

  it('状态指纹漂移或系统会话进入方案时拒绝全部写入', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'smart-groups-'));
    cleanup.push(dir);
    const store = new GroupStore(join(dir, 'groups.json'));
    const manual = await store.create({ userId: 'u1', name: '现有', sessionIds: ['s1'] });
    const stale = store.getUserSnapshotFingerprint('u1');
    await store.update(manual.id, { name: '已改名' });
    await expect(
      store.applySmartGrouping({
        userId: 'u1',
        expectedFingerprint: stale,
        targetSessionIds: ['s1'],
        groups: [],
      }),
    ).rejects.toBeInstanceOf(SmartGroupingConflictError);

    await store.create({
      userId: 'u1',
      name: '系统',
      kind: 'taskboard',
      taskboardId: 'b1',
      sessionIds: ['protected'],
    });
    const current = store.getUserSnapshotFingerprint('u1');
    await expect(
      store.applySmartGrouping({
        userId: 'u1',
        expectedFingerprint: current,
        targetSessionIds: ['protected'],
        groups: [{ name: '错误', sessionIds: ['protected'] }],
      }),
    ).rejects.toThrow('系统分组会话不可调整');
    expect(store.listByUserId('u1').some((group) => group.name === '错误')).toBe(false);
  });
});
