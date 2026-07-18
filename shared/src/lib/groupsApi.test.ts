import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from './authFetch';
import {
  fetchGroups,
  createGroup,
  deleteGroup,
  updateGroup,
  addSessionsToGroup,
  removeSessionsFromGroup,
  fetchGroupSessions,
  fetchGroupSorting,
  saveGroupSorting,
} from './groupsApi';

const mockAuthFetch = vi.mocked(authFetch);

function ok(jsonBody: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(jsonBody),
  } as unknown as Response;
}

function fail(status = 500): Response {
  return {
    ok: false,
    status,
    json: vi.fn().mockResolvedValue({}),
  } as unknown as Response;
}

function lastCall() {
  const [url, init] = mockAuthFetch.mock.calls[mockAuthFetch.mock.calls.length - 1];
  return { url, init: (init ?? {}) as RequestInit };
}

describe('groupsApi', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  describe('fetchGroups', () => {
    it('GET /api/groups 返回 data.groups', async () => {
      const groups = [{ id: 'g1' }];
      mockAuthFetch.mockResolvedValue(ok({ groups }));
      await expect(fetchGroups()).resolves.toEqual(groups);
      expect(lastCall().url).toBe('/api/groups');
    });

    it('body 无 groups 时返回空数组', async () => {
      mockAuthFetch.mockResolvedValue(ok({}));
      await expect(fetchGroups()).resolves.toEqual([]);
    });

    it('非 2xx 时返回空数组（不抛错）', async () => {
      mockAuthFetch.mockResolvedValue(fail());
      await expect(fetchGroups()).resolves.toEqual([]);
    });
  });

  describe('createGroup', () => {
    it('POST，无 sessionIds 时 body 只含 name', async () => {
      const group = { id: 'g1', name: 'A' };
      mockAuthFetch.mockResolvedValue(ok(group));
      await expect(createGroup('A')).resolves.toEqual(group);

      const { url, init } = lastCall();
      expect(url).toBe('/api/groups');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ name: 'A' }));
    });

    it('有 sessionIds 时 body 含 sessionIds', async () => {
      mockAuthFetch.mockResolvedValue(ok({ id: 'g1' }));
      await createGroup('A', ['s1', 's2']);
      expect(lastCall().init.body).toBe(JSON.stringify({ name: 'A', sessionIds: ['s1', 's2'] }));
    });

    it('空 sessionIds 数组不进 body', async () => {
      mockAuthFetch.mockResolvedValue(ok({ id: 'g1' }));
      await createGroup('A', []);
      expect(lastCall().init.body).toBe(JSON.stringify({ name: 'A' }));
    });

    it('非 2xx 时返回 null', async () => {
      mockAuthFetch.mockResolvedValue(fail());
      await expect(createGroup('A')).resolves.toBeNull();
    });
  });

  describe('deleteGroup', () => {
    it('DELETE 且 groupId encode，成功返回 true', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await expect(deleteGroup('g/1')).resolves.toBe(true);

      const { url, init } = lastCall();
      expect(url).toBe('/api/groups/g%2F1');
      expect(init.method).toBe('DELETE');
    });

    it('非 2xx 返回 false', async () => {
      mockAuthFetch.mockResolvedValue(fail());
      await expect(deleteGroup('g1')).resolves.toBe(false);
    });
  });

  describe('updateGroup', () => {
    it('PATCH，body 为 patch', async () => {
      const group = { id: 'g1', name: 'B' };
      mockAuthFetch.mockResolvedValue(ok(group));
      await expect(updateGroup('g1', { name: 'B' })).resolves.toEqual(group);

      const { url, init } = lastCall();
      expect(url).toBe('/api/groups/g1');
      expect(init.method).toBe('PATCH');
      expect(init.body).toBe(JSON.stringify({ name: 'B' }));
    });

    it('非 2xx 返回 null', async () => {
      mockAuthFetch.mockResolvedValue(fail());
      await expect(updateGroup('g1', {})).resolves.toBeNull();
    });
  });

  describe('addSessionsToGroup', () => {
    it('POST sessions，body 带 sessionIds，返回 data.group', async () => {
      const group = { id: 'g1' };
      mockAuthFetch.mockResolvedValue(ok({ group }));
      await expect(addSessionsToGroup('g1', ['s1'])).resolves.toEqual(group);

      const { url, init } = lastCall();
      expect(url).toBe('/api/groups/g1/sessions');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ sessionIds: ['s1'] }));
    });

    it('body 无 group 时返回 null', async () => {
      mockAuthFetch.mockResolvedValue(ok({}));
      await expect(addSessionsToGroup('g1', ['s1'])).resolves.toBeNull();
    });

    it('非 2xx 返回 null', async () => {
      mockAuthFetch.mockResolvedValue(fail());
      await expect(addSessionsToGroup('g1', ['s1'])).resolves.toBeNull();
    });
  });

  describe('removeSessionsFromGroup', () => {
    it('DELETE sessions，body 带 sessionIds', async () => {
      const group = { id: 'g1' };
      mockAuthFetch.mockResolvedValue(ok({ group }));
      await expect(removeSessionsFromGroup('g1', ['s1'])).resolves.toEqual(group);

      const { url, init } = lastCall();
      expect(url).toBe('/api/groups/g1/sessions');
      expect(init.method).toBe('DELETE');
      expect(init.body).toBe(JSON.stringify({ sessionIds: ['s1'] }));
    });

    it('非 2xx 返回 null', async () => {
      mockAuthFetch.mockResolvedValue(fail());
      await expect(removeSessionsFromGroup('g1', ['s1'])).resolves.toBeNull();
    });
  });

  describe('fetchGroupSessions', () => {
    it('GET sessions 返回 data.sessions', async () => {
      const sessions = [{ sessionId: 's1' }];
      mockAuthFetch.mockResolvedValue(ok({ sessions }));
      await expect(fetchGroupSessions('g1')).resolves.toEqual(sessions);
      expect(lastCall().url).toBe('/api/groups/g1/sessions');
    });

    it('非 2xx 返回空数组', async () => {
      mockAuthFetch.mockResolvedValue(fail());
      await expect(fetchGroupSessions('g1')).resolves.toEqual([]);
    });
  });

  describe('fetchGroupSorting', () => {
    it('GET /api/groups-sorting 返回 body', async () => {
      const pref = { mode: 'custom' as const, order: ['g1'] };
      mockAuthFetch.mockResolvedValue(ok(pref));
      await expect(fetchGroupSorting()).resolves.toEqual(pref);
      expect(lastCall().url).toBe('/api/groups-sorting');
    });

    it('非 2xx 返回默认 recent/[]', async () => {
      mockAuthFetch.mockResolvedValue(fail());
      await expect(fetchGroupSorting()).resolves.toEqual({ mode: 'recent', order: [] });
    });
  });

  describe('saveGroupSorting', () => {
    it('PUT，body 为 pref', async () => {
      const pref = { mode: 'custom' as const, order: ['g1'] };
      mockAuthFetch.mockResolvedValue(ok(pref));
      await expect(saveGroupSorting(pref)).resolves.toEqual(pref);

      const { url, init } = lastCall();
      expect(url).toBe('/api/groups-sorting');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify(pref));
    });

    it('非 2xx 返回 null', async () => {
      mockAuthFetch.mockResolvedValue(fail());
      await expect(saveGroupSorting({ mode: 'recent', order: [] })).resolves.toBeNull();
    });
  });
});
