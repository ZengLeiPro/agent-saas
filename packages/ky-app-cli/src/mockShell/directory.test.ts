/** mock 目录服务（附录 L）：鉴权、快照分页、变更流、410、重放与 credential-ack。 */
import { describe, expect, it } from 'vitest';

import { validateDirectoryChanges, validateDirectorySnapshot } from '@kaiyan/ky-app-contract';

import { createMockDirectory, type MockDirectory } from './directory.js';

const CREDENTIAL = 'svc_test';
const IID = 'tsi_01';
const BASE = 'http://mock.invalid/api/app-contract/v1';

function make(pageSize = 2): MockDirectory {
  const directory = createMockDirectory({
    serviceCredential: CREDENTIAL,
    installationId: IID,
    pageSize,
  });
  directory.setSnapshot({
    snapshotSeq: 10,
    groups: [{ groupId: 'g1', displayName: '总部', parentGroupId: null, status: 'active' }],
    users: ['u1', 'u2', 'u3'].map((userId) => ({
      userId,
      displayName: userId,
      status: 'active' as const,
      isTenantAdmin: false,
      groupIds: ['g1'],
    })),
  });
  return directory;
}

async function get(
  directory: MockDirectory,
  path: string,
  credential = CREDENTIAL,
): Promise<Response> {
  const response = await directory.handle(
    new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${credential}` } }),
  );
  if (response === null) throw new Error('目录服务没有接管这个路径');
  return response;
}

describe('createMockDirectory', () => {
  it('非目录路径返回 null（交给壳的其他路由）', async () => {
    const directory = make();
    expect(await directory.handle(new Request('http://mock.invalid/shell'))).toBeNull();
  });

  it('服务凭据不对 → 401', async () => {
    const directory = make();
    const response = await get(directory, '/directory/snapshot', 'wrong');
    expect(response.status).toBe(401);
  });

  it('快照按 pageSize 分页，各页 snapshotSeq 一致且合附录 L', async () => {
    const directory = make(2);
    const first = (await (await get(directory, '/directory/snapshot')).json()) as Record<
      string,
      unknown
    >;
    expect(validateDirectorySnapshot(first).ok).toBe(true);
    expect(first.snapshotSeq).toBe(10);
    expect((first.users as unknown[]).length).toBe(2);
    expect((first.groups as unknown[]).length).toBe(1);
    expect(first.pageToken).toBe('1');

    const second = (await (
      await get(directory, `/directory/snapshot?pageToken=${String(first.pageToken)}`)
    ).json()) as Record<string, unknown>;
    expect(validateDirectorySnapshot(second).ok).toBe(true);
    expect(second.snapshotSeq).toBe(10);
    expect((second.users as unknown[]).length).toBe(1);
    expect((second.groups as unknown[]).length).toBe(0);
    expect(second.pageToken).toBeUndefined();
  });

  it('变更流按 after 过滤、按 limit 截断并给出 hasMore', async () => {
    const directory = make();
    directory.pushEvents([
      { eventId: 'e1', type: 'user.remove', userId: 'u1' },
      { eventId: 'e2', type: 'user.remove', userId: 'u2' },
      { eventId: 'e3', type: 'user.remove', userId: 'u3' },
    ]);
    const page = (await (await get(directory, '/directory/changes?after=10&limit=2')).json()) as {
      events: Array<{ seq: number }>;
      nextSeq: number;
      hasMore: boolean;
    };
    expect(validateDirectoryChanges(page).ok).toBe(true);
    expect(page.events.map((event) => event.seq)).toEqual([11, 12]);
    expect(page.nextSeq).toBe(12);
    expect(page.hasMore).toBe(true);

    const rest = (await (await get(directory, '/directory/changes?after=12&limit=500')).json()) as {
      events: Array<{ seq: number }>;
      hasMore: boolean;
    };
    expect(rest.events.map((event) => event.seq)).toEqual([13]);
    expect(rest.hasMore).toBe(false);
  });

  it('没有新事件时 nextSeq 不回退', async () => {
    const directory = make();
    const page = (await (await get(directory, '/directory/changes?after=10&limit=500')).json()) as {
      events: unknown[];
      nextSeq: number;
      hasMore: boolean;
    };
    expect(page.events).toEqual([]);
    expect(page.nextSeq).toBe(10);
    expect(page.hasMore).toBe(false);
  });

  it('expireCursor / expireSnapshot 只影响下一次请求，且响应合附录 L', async () => {
    const directory = make();
    directory.expireCursor();
    const gone = await get(directory, '/directory/changes?after=10');
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ code: 'cursor_expired' });
    expect((await get(directory, '/directory/changes?after=10')).status).toBe(200);

    directory.expireSnapshot();
    const goneSnapshot = await get(directory, '/directory/snapshot');
    expect(goneSnapshot.status).toBe(410);
    expect(await goneSnapshot.json()).toEqual({ code: 'snapshot_expired' });
    expect((await get(directory, '/directory/snapshot')).status).toBe(200);
  });

  it('replayNextChangesFrom 让服务端重发旧 seq（用于验证消费端幂等）', async () => {
    const directory = make();
    directory.pushEvents([{ eventId: 'e1', type: 'user.remove', userId: 'u1' }]);
    directory.replayNextChangesFrom(11);
    const page = (await (await get(directory, '/directory/changes?after=11&limit=500')).json()) as {
      events: Array<{ seq: number }>;
      nextSeq: number;
    };
    expect(page.events.map((event) => event.seq)).toEqual([11]);
    expect(page.nextSeq).toBe(11);
  });

  it('credential-ack 只认本安装实例的路径', async () => {
    const directory = make();
    expect(directory.credentialAcked()).toBe(false);
    const wrong = await directory.handle(
      new Request(`${BASE}/installations/other/credential-ack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${CREDENTIAL}` },
      }),
    );
    expect(wrong?.status).toBe(404);
    const ok = await directory.handle(
      new Request(`${BASE}/installations/${IID}/credential-ack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${CREDENTIAL}` },
      }),
    );
    expect(ok?.status).toBe(200);
    expect(directory.credentialAcked()).toBe(true);
  });

  it('记录请求日志，便于断言分页与续流', async () => {
    const directory = make();
    await get(directory, '/directory/snapshot');
    await get(directory, '/directory/snapshot?pageToken=1');
    expect(directory.calls).toEqual([
      '/api/app-contract/v1/directory/snapshot',
      '/api/app-contract/v1/directory/snapshot?pageToken=1',
    ]);
  });
});
