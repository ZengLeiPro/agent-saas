/** §3.4 / §3.6 / §9.3-12 目录消费算法、陈旧度门禁与本地用户状态。 */
import { beforeEach, describe, expect, it } from 'vitest';

import { DIRECTORY_STALENESS_SECONDS, type DirectoryUser } from '@kaiyan/ky-app-contract';

import { DIRECTORY_RATE_LIMIT, createDirectoryClient } from './client.js';
import { directoryStalenessGate } from './staleness.js';
import { MemoryDirectoryStore } from './store.js';
import { BASE_NOW_MS, createClock, createTestConfig } from '../__tests__/helpers.js';

const config = createTestConfig();

function user(userId: string, overrides: Partial<DirectoryUser> = {}): DirectoryUser {
  return {
    userId,
    displayName: `员工${userId}`,
    status: 'active',
    isTenantAdmin: false,
    groupIds: ['g1'],
    ...overrides,
  };
}

const GROUP = { groupId: 'g1', displayName: '销售部', status: 'active' as const };

interface MockDirectoryOptions {
  pages?: Array<{ snapshotSeq: number; users: DirectoryUser[]; pageToken?: string }>;
  changes?: Array<{ events: unknown[]; nextSeq: number; hasMore: boolean }>;
  gone?: 'snapshot_expired' | 'cursor_expired' | null;
}

function createMockDirectory(options: MockDirectoryOptions) {
  const state = {
    calls: [] as string[],
    gone: options.gone ?? null,
    pages: options.pages ?? [{ snapshotSeq: 10, users: [user('u1')] }],
    changes: options.changes ?? [],
    changeIndex: 0,
    authHeaders: [] as string[],
  };
  const fetchLike = async (input: string, init?: RequestInit): Promise<Response> => {
    state.calls.push(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.authorization !== undefined) state.authHeaders.push(headers.authorization);
    const url = new URL(input, 'https://api.test.invalid');

    if (url.pathname.endsWith('/credential-ack')) return new Response(null, { status: 204 });

    if (url.pathname.endsWith('/directory/snapshot')) {
      if (state.gone === 'snapshot_expired') {
        state.gone = null;
        return Response.json({ code: 'snapshot_expired' }, { status: 410 });
      }
      const token = url.searchParams.get('pageToken');
      const index = token === null ? 0 : Number(token);
      const page = state.pages[index];
      return Response.json({
        snapshotSeq: page.snapshotSeq,
        users: page.users,
        groups: index === 0 ? [GROUP] : [],
        ...(page.pageToken === undefined ? {} : { pageToken: page.pageToken }),
      });
    }

    if (url.pathname.endsWith('/directory/changes')) {
      if (state.gone === 'cursor_expired') {
        state.gone = null;
        return Response.json({ code: 'cursor_expired' }, { status: 410 });
      }
      const batch = state.changes[state.changeIndex] ?? {
        events: [],
        nextSeq: Number(url.searchParams.get('after')),
        hasMore: false,
      };
      state.changeIndex += 1;
      return Response.json(batch);
    }
    return new Response('not found', { status: 404 });
  };
  return { state, fetch: fetchLike };
}

let clock: ReturnType<typeof createClock>;
let store: MemoryDirectoryStore;

beforeEach(() => {
  clock = createClock();
  store = new MemoryDirectoryStore();
});

function client(mock: ReturnType<typeof createMockDirectory>) {
  return createDirectoryClient({
    config,
    store,
    baseUrl: 'https://api.test.invalid/',
    fetch: mock.fetch,
    now: clock.now,
  });
}

describe('快照与变更流消费（§3.6）', () => {
  it('首次拉快照，checkpoint = snapshotSeq，凭据走 Bearer', async () => {
    const mock = createMockDirectory({});
    const result = await client(mock).sync();
    expect(result).toMatchObject({ status: 'snapshot', checkpoint: 10 });
    expect(await store.getCheckpoint()).toMatchObject({ seq: 10 });
    expect(mock.state.authHeaders[0]).toBe(`Bearer ${config.serviceCredential}`);
    expect(await store.listGroups()).toHaveLength(1);
  });

  it('分页快照全部页 snapshotSeq 一致时合并应用', async () => {
    const mock = createMockDirectory({
      pages: [
        { snapshotSeq: 7, users: [user('u1')], pageToken: '1' },
        { snapshotSeq: 7, users: [user('u2')] },
      ],
    });
    await client(mock).sync();
    expect(await store.listUsers()).toHaveLength(2);
    expect(await store.getCheckpoint()).toMatchObject({ seq: 7 });
  });

  it('分页 snapshotSeq 不一致 → 重拉；仍不一致则报错', async () => {
    const mock = createMockDirectory({
      pages: [
        { snapshotSeq: 7, users: [user('u1')], pageToken: '1' },
        { snapshotSeq: 8, users: [user('u2')] },
      ],
    });
    await expect(client(mock).sync()).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('之后从 checkpoint 续流，seq ≤ checkpoint 忽略，nextSeq 成为新 checkpoint', async () => {
    const mock = createMockDirectory({
      changes: [
        {
          events: [
            { seq: 5, eventId: 'e5', type: 'user.upsert', user: user('u-old') },
            { seq: 11, eventId: 'e11', type: 'user.upsert', user: user('u2') },
          ],
          nextSeq: 11,
          hasMore: false,
        },
      ],
    });
    const directory = client(mock);
    await directory.sync();
    const result = await directory.sync();
    expect(result).toMatchObject({ status: 'changes', checkpoint: 11 });
    expect(await store.getUser('u-old')).toBeNull();
    expect(await store.getUser('u2')).not.toBeNull();
  });

  it('hasMore 时继续翻页直到取完', async () => {
    const mock = createMockDirectory({
      changes: [
        {
          events: [{ seq: 11, eventId: 'e11', type: 'user.upsert', user: user('u2') }],
          nextSeq: 11,
          hasMore: true,
        },
        {
          events: [{ seq: 12, eventId: 'e12', type: 'user.upsert', user: user('u3') }],
          nextSeq: 12,
          hasMore: false,
        },
      ],
    });
    const directory = client(mock);
    await directory.sync();
    const result = await directory.sync();
    expect(result.applied).toBe(2);
    expect(await store.getCheckpoint()).toMatchObject({ seq: 12 });
  });

  it('410 cursor_expired 触发整份重拉快照', async () => {
    const mock = createMockDirectory({ gone: null });
    const directory = client(mock);
    await directory.sync();
    mock.state.gone = 'cursor_expired';
    const result = await directory.sync();
    expect(result).toMatchObject({ status: 'snapshot', resnapshot: true });
  });

  it('每分钟 ≤ 60 次限速；超限返回 rate_limited 而不是抛错', async () => {
    const mock = createMockDirectory({});
    const directory = client(mock);
    for (let index = 0; index < DIRECTORY_RATE_LIMIT.max; index += 1) await directory.sync();
    expect(await directory.sync()).toMatchObject({ status: 'rate_limited' });
    clock.advance(DIRECTORY_RATE_LIMIT.windowMs + 1);
    expect((await directory.sync()).status).not.toBe('rate_limited');
  });

  it('不合附录 L 的响应一律拒绝', async () => {
    const mock = createMockDirectory({});
    mock.state.pages = [{ snapshotSeq: -1, users: [] }];
    await expect(client(mock).sync()).rejects.toMatchObject({ code: 'internal' });
  });

  it('credential-ack 打到安装实例路径', async () => {
    const mock = createMockDirectory({});
    await client(mock).ackCredential();
    expect(
      mock.state.calls.some((call) =>
        call.includes(`/installations/${config.installationId}/credential-ack`),
      ),
    ).toBe(true);
  });
});

describe('本地用户状态（§3.4）', () => {
  it('目录 disabled → suspended，重新 active 不自动复活，管理员显式复活才生效', async () => {
    const mock = createMockDirectory({
      changes: [
        {
          events: [
            {
              seq: 11,
              eventId: 'e11',
              type: 'user.upsert',
              user: user('u1', { status: 'disabled' }),
            },
          ],
          nextSeq: 11,
          hasMore: false,
        },
        {
          events: [
            {
              seq: 12,
              eventId: 'e12',
              type: 'user.upsert',
              user: user('u1', { status: 'active' }),
            },
          ],
          nextSeq: 12,
          hasMore: false,
        },
      ],
    });
    const directory = client(mock);
    await directory.sync();
    await directory.sync();
    expect((await store.getUser('u1'))?.localStatus).toBe('suspended');
    await directory.sync();
    expect((await store.getUser('u1'))?.localStatus).toBe('suspended');
    await store.reinstateUser('u1', clock.now());
    expect((await store.getUser('u1'))?.localStatus).toBe('active');
  });

  it('user.remove → 标记离职并保留数据', async () => {
    const mock = createMockDirectory({
      changes: [
        {
          events: [{ seq: 11, eventId: 'e11', type: 'user.remove', userId: 'u1' }],
          nextSeq: 11,
          hasMore: false,
        },
      ],
    });
    const directory = client(mock);
    await directory.sync();
    await directory.sync();
    const removed = await store.getUser('u1');
    expect(removed).toMatchObject({ removed: true, localStatus: 'suspended' });
    expect(removed?.displayName).toBe('员工u1');
  });

  it('adminRole 双通道：目录事件与 SAT tadm 都能改写', async () => {
    const mock = createMockDirectory({
      pages: [{ snapshotSeq: 10, users: [user('u1', { isTenantAdmin: true })] }],
    });
    const directory = client(mock);
    await directory.sync();
    expect((await store.getUser('u1'))?.isTenantAdmin).toBe(true);
    await directory.applySatTenantAdmin('u1', false);
    expect((await store.getUser('u1'))?.isTenantAdmin).toBe(false);
  });
});

describe('陈旧度门禁（§3.4）', () => {
  it('三级阈值', () => {
    expect(directoryStalenessGate(0)).toMatchObject({
      warn: false,
      allowWrite: true,
      allowRead: true,
    });
    expect(directoryStalenessGate(DIRECTORY_STALENESS_SECONDS.warn + 1).warn).toBe(true);
    expect(directoryStalenessGate(DIRECTORY_STALENESS_SECONDS.blockWrite).allowWrite).toBe(true);
    expect(directoryStalenessGate(DIRECTORY_STALENESS_SECONDS.blockWrite + 1)).toMatchObject({
      allowWrite: false,
      allowRead: true,
    });
    expect(directoryStalenessGate(DIRECTORY_STALENESS_SECONDS.blockRead + 1)).toMatchObject({
      allowWrite: false,
      allowRead: false,
    });
  });

  it('从未同步过一律 fail-closed', async () => {
    const mock = createMockDirectory({});
    const gate = await client(mock).staleness();
    expect(gate).toMatchObject({ allowWrite: false, allowRead: false });
  });

  it('同步后随时钟推进逐级降级', async () => {
    const mock = createMockDirectory({});
    const directory = client(mock);
    await directory.sync();
    expect(await directory.staleness()).toMatchObject({ allowWrite: true, allowRead: true });
    clock.advance((DIRECTORY_STALENESS_SECONDS.blockWrite + 1) * 1000);
    expect(await directory.staleness()).toMatchObject({ allowWrite: false, allowRead: true });
    clock.advance(DIRECTORY_STALENESS_SECONDS.blockRead * 1000);
    expect(await directory.staleness()).toMatchObject({ allowWrite: false, allowRead: false });
    expect(BASE_NOW_MS).toBeGreaterThan(0);
  });
});
