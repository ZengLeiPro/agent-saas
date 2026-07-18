import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./authFetch', () => ({
  authFetch: vi.fn(),
}));

import { authFetch } from './authFetch';
import {
  fetchAgentProfile,
  fetchAllAgentProfiles,
  updateAgentProfile,
  fetchPersona,
  updatePersona,
  fetchAgentMemory,
  updateAgentMemory,
  uploadAgentAvatar,
  isEmojiAvatar,
  getAgentAvatarUrl,
} from './agentsApi';

const mockAuthFetch = vi.mocked(authFetch);

function ok(jsonBody: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(jsonBody),
  } as unknown as Response;
}

function fail(status: number, jsonBody?: unknown): Response {
  return {
    ok: false,
    status,
    json:
      jsonBody === undefined
        ? vi.fn().mockRejectedValue(new Error('no body'))
        : vi.fn().mockResolvedValue(jsonBody),
  } as unknown as Response;
}

function lastCall() {
  const [url, init] = mockAuthFetch.mock.calls[mockAuthFetch.mock.calls.length - 1];
  return { url, init: (init ?? {}) as RequestInit };
}

describe('agentsApi — 网络方法', () => {
  beforeEach(() => {
    mockAuthFetch.mockReset();
  });

  describe('fetchAgentProfile', () => {
    it('GET /api/agents/:username 并返回 body', async () => {
      const body = { username: 'alice', name: 'Alice' };
      mockAuthFetch.mockResolvedValue(ok(body));
      await expect(fetchAgentProfile('alice')).resolves.toEqual(body);
      expect(lastCall().url).toBe('/api/agents/alice');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(404));
      await expect(fetchAgentProfile('x')).rejects.toThrow('Failed to fetch agent profile: 404');
    });
  });

  describe('fetchAllAgentProfiles', () => {
    it('无 options 时 GET /api/agents（无 query）', async () => {
      mockAuthFetch.mockResolvedValue(ok([]));
      await expect(fetchAllAgentProfiles()).resolves.toEqual([]);
      expect(lastCall().url).toBe('/api/agents');
    });

    it('scope=currentTenant 时拼 query', async () => {
      mockAuthFetch.mockResolvedValue(ok([{ username: 'a' }]));
      await fetchAllAgentProfiles({ scope: 'currentTenant' });
      expect(lastCall().url).toBe('/api/agents?scope=currentTenant');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(fetchAllAgentProfiles()).rejects.toThrow('Failed to fetch agent profiles: 500');
    });
  });

  describe('updateAgentProfile', () => {
    it('PATCH 并把 data 拼进 body', async () => {
      const body = { username: 'alice', name: 'New' };
      mockAuthFetch.mockResolvedValue(ok(body));
      await expect(updateAgentProfile('alice', { name: 'New' })).resolves.toEqual(body);

      const { url, init } = lastCall();
      expect(url).toBe('/api/agents/alice');
      expect(init.method).toBe('PATCH');
      expect(init.body).toBe(JSON.stringify({ name: 'New' }));
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(400));
      await expect(updateAgentProfile('a', {})).rejects.toThrow('Failed to update agent profile: 400');
    });
  });

  describe('fetchPersona', () => {
    it('GET persona 并返回 data.content', async () => {
      mockAuthFetch.mockResolvedValue(ok({ content: 'i am alice' }));
      await expect(fetchPersona('alice')).resolves.toBe('i am alice');
      expect(lastCall().url).toBe('/api/agents/alice/persona');
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(404));
      await expect(fetchPersona('a')).rejects.toThrow('Failed to fetch persona: 404');
    });
  });

  describe('updatePersona', () => {
    it('PUT persona，body 带 content', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updatePersona('alice', 'text');

      const { url, init } = lastCall();
      expect(url).toBe('/api/agents/alice/persona');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ content: 'text' }));
    });

    it('非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(400));
      await expect(updatePersona('a', 'x')).rejects.toThrow('Failed to update persona: 400');
    });
  });

  describe('fetchAgentMemory / updateAgentMemory', () => {
    it('GET memory 返回 data.content', async () => {
      mockAuthFetch.mockResolvedValue(ok({ content: 'mem' }));
      await expect(fetchAgentMemory('alice')).resolves.toBe('mem');
      expect(lastCall().url).toBe('/api/agents/alice/memory');
    });

    it('fetchAgentMemory 非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      await expect(fetchAgentMemory('a')).rejects.toThrow('Failed to fetch memory: 500');
    });

    it('PUT memory，body 带 content', async () => {
      mockAuthFetch.mockResolvedValue(ok());
      await updateAgentMemory('alice', 'new mem');

      const { url, init } = lastCall();
      expect(url).toBe('/api/agents/alice/memory');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ content: 'new mem' }));
    });

    it('updateAgentMemory 非 2xx 抛错', async () => {
      mockAuthFetch.mockResolvedValue(fail(400));
      await expect(updateAgentMemory('a', 'x')).rejects.toThrow('Failed to update memory: 400');
    });
  });

  describe('uploadAgentAvatar', () => {
    it('POST avatar，body 为 FormData，成功返回 data.avatar', async () => {
      mockAuthFetch.mockResolvedValue(ok({ avatar: 'agent-avatars/x.png' }));
      const file = new File(['x'], 'a.png', { type: 'image/png' });
      await expect(uploadAgentAvatar('alice', file)).resolves.toBe('agent-avatars/x.png');

      const { url, init } = lastCall();
      expect(url).toBe('/api/agents/alice/avatar');
      expect(init.method).toBe('POST');
      expect(init.body).toBeInstanceOf(FormData);
    });

    it('失败时优先抛 body.error', async () => {
      mockAuthFetch.mockResolvedValue(fail(413, { error: '图片过大' }));
      const file = new File(['x'], 'a.png', { type: 'image/png' });
      await expect(uploadAgentAvatar('alice', file)).rejects.toThrow('图片过大');
    });

    it('失败但 body 解析失败时抛默认信息', async () => {
      mockAuthFetch.mockResolvedValue(fail(500));
      const file = new File(['x'], 'a.png', { type: 'image/png' });
      await expect(uploadAgentAvatar('alice', file)).rejects.toThrow('上传失败 (500)');
    });
  });
});

describe('agentsApi — 纯函数', () => {
  describe('isEmojiAvatar', () => {
    it('空值视为 emoji', () => {
      expect(isEmojiAvatar()).toBe(true);
      expect(isEmojiAvatar('')).toBe(true);
    });

    it('文件路径前缀视为非 emoji', () => {
      expect(isEmojiAvatar('agent-avatars/x.png')).toBe(false);
      expect(isEmojiAvatar('org-agent-avatars/y.png')).toBe(false);
    });

    it('普通字符（emoji）视为 emoji', () => {
      expect(isEmojiAvatar('🤖')).toBe(true);
    });
  });

  describe('getAgentAvatarUrl', () => {
    it('emoji / 空 avatar 返回 null', () => {
      expect(getAgentAvatarUrl('alice', '🤖')).toBeNull();
      expect(getAgentAvatarUrl('alice')).toBeNull();
    });

    it('个人头像走 /api/agents/avatar/:username', () => {
      expect(getAgentAvatarUrl('alice', 'agent-avatars/x.png', 'https://s')).toBe(
        'https://s/api/agents/avatar/alice',
      );
    });

    it('企业专家头像走 org-agents 路径，剥离 org-agent: 前缀并 encode', () => {
      expect(
        getAgentAvatarUrl('org-agent:id 1', 'org-agent-avatars/y.png', 'https://s'),
      ).toBe('https://s/api/org-agents/avatar/id%201');
    });

    it('带 version 时拼上 ?v=', () => {
      expect(getAgentAvatarUrl('alice', 'agent-avatars/x.png', 'https://s', 5)).toBe(
        'https://s/api/agents/avatar/alice?v=5',
      );
    });
  });
});
