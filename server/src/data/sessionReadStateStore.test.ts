import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FileSessionReadStateStore } from './sessionReadStateStore.js';

const identity = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  sessionId: 'session-1',
};

describe('FileSessionReadStateStore', () => {
  it('推进关注版本并支持标记已读', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-read-state-'));
    const filePath = join(dir, 'states.json');
    const store = new FileSessionReadStateStore(filePath);
    await store.init();

    expect(await store.listUnreadSessionIds({
      tenantId: identity.tenantId,
      userId: identity.userId,
      sessionIds: [identity.sessionId],
    })).toEqual(new Set());

    expect(await store.markUnread({ ...identity, eventKey: 'done:run-1' })).toBe(true);
    expect(await store.markUnread({ ...identity, eventKey: 'done:run-1' })).toBe(false);
    expect(await store.getState(identity)).toEqual({ attentionVersion: 1, readVersion: 0 });
    expect(await store.listUnreadSessionIds({
      tenantId: identity.tenantId,
      userId: identity.userId,
      sessionIds: [identity.sessionId],
    })).toEqual(new Set([identity.sessionId]));

    expect(await store.markRead(identity)).toBe(true);
    expect(await store.markRead(identity)).toBe(false);
    expect(await store.getState(identity)).toEqual({ attentionVersion: 1, readVersion: 1 });
    expect(await store.listUnreadSessionIds({
      tenantId: identity.tenantId,
      userId: identity.userId,
      sessionIds: [identity.sessionId],
    })).toEqual(new Set());
  });

  it('重启后保留状态并隔离租户与用户', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'session-read-state-'));
    const filePath = join(dir, 'states.json');
    const first = new FileSessionReadStateStore(filePath);
    await first.init();
    await first.markUnread({ ...identity, eventKey: 'interaction:1' });

    const second = new FileSessionReadStateStore(filePath);
    await second.init();

    expect(await second.listUnreadSessionIds({
      tenantId: identity.tenantId,
      userId: identity.userId,
      sessionIds: [identity.sessionId],
    })).toEqual(new Set([identity.sessionId]));
    expect(await second.listUnreadSessionIds({
      tenantId: identity.tenantId,
      userId: 'other-user',
      sessionIds: [identity.sessionId],
    })).toEqual(new Set());
    expect(JSON.parse(await readFile(filePath, 'utf-8'))).toBeTruthy();
  });
});
