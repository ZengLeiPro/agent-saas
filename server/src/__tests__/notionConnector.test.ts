import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConnectorConnectionStore } from '../connectors/connectionStore.js';
import {
  connectNotionCredential,
  disconnectNotion,
  getLiveNotionConnection,
  NOTION_LOCAL_DISCONNECT_NOTICE,
  NOTION_VERSION,
  resolveNotionRuntimeEnv,
} from '../connectors/notion.js';
import { InMemorySecretVault, type SecretVault } from '../security/secretVault.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function rig() {
  const root = mkdtempSync(join(tmpdir(), 'notion-connector-'));
  roots.push(root);
  const storePath = join(root, 'connections.json');
  return {
    storePath,
    connectionStore: new ConnectorConnectionStore(storePath),
    vault: new InMemorySecretVault(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function personBody(name = 'Alice') {
  return {
    object: 'user',
    id: 'person-1',
    type: 'person',
    name,
    avatar_url: null,
    person: { email: 'alice@example.com' },
  };
}

function botBody() {
  return {
    object: 'user',
    id: 'bot-1',
    type: 'bot',
    name: 'Agent Bot',
    avatar_url: null,
    bot: {
      owner: { type: 'workspace', workspace: true },
      workspace_name: 'Live Workspace Name',
    },
  };
}

const identity = { userId: 'user-1', username: 'alice', tenantId: 'tenant-a' };

async function connectPerson(
  r: ReturnType<typeof rig>,
  fetchImpl: typeof fetch = vi.fn(async () => jsonResponse(personBody())),
) {
  return await connectNotionCredential({
    ...r,
    ...identity,
    token: 'ntn_secret_token',
    fetchImpl,
  });
}

describe('Notion native connector', () => {
  it('写入 Vault 前 live verify，并保存真实用户身份', async () => {
    const r = rig();
    const fetchImpl = vi.fn(async () => jsonResponse(personBody()));
    const connection = await connectPerson(r, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.notion.com/v1/users/me',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer ntn_secret_token',
          'Notion-Version': NOTION_VERSION,
        },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(connection).toMatchObject({
      status: 'connected',
      identity: {
        id: 'person-1',
        type: 'person',
        name: 'Alice',
        email: 'alice@example.com',
      },
    });
    expect(connection.verifiedAt).toBeTruthy();
    await expect(resolveNotionRuntimeEnv(r, identity)).resolves.toEqual({ NOTION_API_TOKEN: 'ntn_secret_token' });
  });

  it('展示 bot identity 与 Notion 返回的 workspace name', async () => {
    const r = rig();
    const connection = await connectNotionCredential({
      ...r,
      ...identity,
      token: 'ntn_bot_secret',
      fetchImpl: vi.fn(async () => jsonResponse(botBody())),
    });
    expect(connection).toMatchObject({
      workspaceName: 'Live Workspace Name',
      identity: { id: 'bot-1', type: 'bot', name: 'Agent Bot', botOwnerType: 'workspace' },
    });
  });

  it('401 与 403 标为 invalid，保留 Vault secret 但停止运行时注入', async () => {
    for (const status of [401, 403]) {
      const r = rig();
      await connectPerson(r);
      const connection = await getLiveNotionConnection({
        ...r,
        ...identity,
        fetchImpl: vi.fn(async () => jsonResponse({ message: 'rejected' }, status)),
      });
      expect(connection.status).toBe('invalid');
      expect(connection.identity).toMatchObject({ id: 'person-1' });
      await expect(resolveNotionRuntimeEnv(r, identity)).resolves.toEqual({});
    }
  });

  it.each([
    ['429', vi.fn(async () => jsonResponse({ message: 'rate limited' }, 429))],
    ['5xx', vi.fn(async () => jsonResponse({ message: 'down' }, 503))],
    ['network', vi.fn(async () => { throw new Error('socket failed'); })],
  ])('%s 标为 unavailable，保留上次身份和运行时注入', async (_kind, fetchImpl) => {
    const r = rig();
    const first = await connectPerson(r);
    const connection = await getLiveNotionConnection({ ...r, ...identity, fetchImpl });
    expect(connection).toMatchObject({
      status: 'unavailable',
      identity: { id: 'person-1', type: 'person' },
      connectedAt: first.connectedAt,
    });
    await expect(resolveNotionRuntimeEnv(r, identity)).resolves.toEqual({ NOTION_API_TOKEN: 'ntn_secret_token' });
  });

  it('Vault 临时不可读时标为 unavailable，而不是误判授权 invalid', async () => {
    const r = rig();
    await connectPerson(r);
    const vault = {
      ...r.vault,
      getSecret: vi.fn(async () => { throw new Error('vault down'); }),
    } as unknown as SecretVault;
    const connection = await getLiveNotionConnection({
      connectionStore: r.connectionStore,
      vault,
      ...identity,
      fetchImpl: vi.fn(),
    });
    expect(connection.status).toBe('unavailable');
  });

  it('live verify 成功后刷新身份和 verifiedAt，不改变 connectedAt', async () => {
    const r = rig();
    const first = await connectPerson(r);
    await new Promise(resolve => setTimeout(resolve, 2));
    const refreshed = await getLiveNotionConnection({
      ...r,
      ...identity,
      fetchImpl: vi.fn(async () => jsonResponse(personBody('Alice Updated'))),
    });
    expect(refreshed.status).toBe('connected');
    expect(refreshed.identity?.name).toBe('Alice Updated');
    expect(refreshed.verifiedAt).not.toBe(first.verifiedAt);
    expect(refreshed.connectedAt).toBe(first.connectedAt);
  });

  it('本地断开幂等，并明确 Notion provider 未远程撤销', async () => {
    const r = rig();
    await connectPerson(r);
    const first = await disconnectNotion({ ...r, ...identity });
    const second = await disconnectNotion({ ...r, ...identity });

    expect(first).toEqual({
      connection: expect.objectContaining({ status: 'disconnected' }),
      providerRevoked: false,
      notice: NOTION_LOCAL_DISCONNECT_NOTICE,
    });
    expect(second.notice).toContain('Notion 中移除授权/令牌');
    await expect(resolveNotionRuntimeEnv(r, identity)).resolves.toEqual({});
  });

  it('验证失败的 token 不进入记录或错误文本', async () => {
    const r = rig();
    const token = 'ntn_do_not_leak_123';
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toContain(token);
      throw new Error(`network failed with ${token}`);
    });
    let message = '';
    try {
      await connectNotionCredential({ ...r, ...identity, token, fetchImpl });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(token);
    const persisted = existsSync(r.storePath) ? readFileSync(r.storePath, 'utf8') : '';
    expect(persisted).not.toContain(token);
    await expect(resolveNotionRuntimeEnv(r, identity)).resolves.toEqual({});
  });
});
