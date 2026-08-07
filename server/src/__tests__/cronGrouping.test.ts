import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCronRuntime } from '../cron/bootstrap.js';
import { GroupStore } from '../data/groups/store.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Cron session grouping', () => {
  it('persists the cron group before publishing the grouped event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cron-grouping-'));
    cleanupPaths.push(root);
    const groupStore = new GroupStore(join(root, 'data', 'groups.json'));
    const groupedEvents: Array<{
      sessionId: string;
      groupId: string;
      userId: string;
    }> = [];

    const runtime = createCronRuntime({
      config: {
        cron: {
          enabled: true,
          store: './data/cron/jobs.json',
        },
        server: { timezone: 'Asia/Shanghai' },
      } as any,
      agentCwd: join(root, 'workspaces'),
      sharedDir: join(root, 'shared'),
      processCwd: root,
      runAgent: ((_message: unknown, _context: unknown, _options: unknown, hooks: any) => (
        async function* () {
          await hooks?.onSessionStart?.('session-1', join(root, 'session-1.jsonl'));
          yield { type: 'text_delta', content: '完成' };
          yield { type: 'done' };
        }
      )()) as any,
      groupStore,
      userStore: {
        findById: () => ({
          id: 'user-1',
          username: 'alice',
          role: 'user',
          tenantId: 'tenant-1',
        }),
      },
      onSessionGrouped: async (event) => {
        // 回调内读取同一 store，验证 publish 严格发生在持久化之后。
        expect(groupStore.findById(event.groupId)?.sessionIds).toContain(event.sessionId);
        groupedEvents.push(event);
      },
    });

    const job = await runtime.service!.add({
      name: '每日报告',
      schedule: { kind: 'at', atMs: Date.now() + 60_000 },
      payload: { kind: 'agentTurn', message: '生成日报' },
    }, { owner: 'user-1', ownerName: 'Alice' });

    expect(await runtime.service!.runNow(job.id)).toEqual({ ran: true });
    await vi.waitFor(() => expect(groupedEvents).toHaveLength(1));

    expect(groupedEvents[0]).toMatchObject({
      sessionId: 'session-1',
      groupId: `cron:${job.id}`,
      userId: 'user-1',
    });
  });
});
