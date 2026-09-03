import { describe, expect, it, vi } from 'vitest';

import { InMemorySecretVault } from '../security/secretVault.js';
import type { EgressWebSocket, EgressWebSocketConnector } from '../runtime/egressDispatcher.js';
import {
  CodexCredentialManager,
  type CodexSubscriptionRuntimeConfig,
} from '../runtime/responses/codexCredentialManager.js';
import {
  CodexResponsesWebSocketPool,
  CodexWebSocketCredentialStaleError,
} from '../runtime/responses/codexResponsesWebSocketPool.js';
import { CodexSubscriptionResponsesTransport } from '../runtime/responses/codexSubscriptionResponsesTransport.js';

class FakeWebSocket extends EventTarget {
  readyState = 1;
  binaryType: 'blob' | 'arraybuffer' = 'arraybuffer';
  readonly sent: string[] = [];

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket closed');
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(eventWith('close', { code, reason, wasClean: true }));
  }

  emit(payload: unknown): void {
    this.dispatchEvent(eventWith('message', { data: JSON.stringify(payload) }));
  }
}

function eventWith(type: string, values: Record<string, unknown>): Event {
  const event = new Event(type);
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}

function connectorFor(
  ...sockets: FakeWebSocket[]
): EgressWebSocketConnector & ReturnType<typeof vi.fn> {
  const mock = vi.fn();
  for (const socket of sockets) mock.mockResolvedValueOnce(socket as unknown as EgressWebSocket);
  return mock as EgressWebSocketConnector & ReturnType<typeof vi.fn>;
}

function request(credentialGeneration: number) {
  return {
    endpoint: 'https://chatgpt.com/backend-api/codex/responses',
    accessToken: `generation-${credentialGeneration}-token`,
    accountId: 'acct-1',
    accountBindingHash: 'binding-1',
    credentialRef: 'credential-1',
    credentialGeneration,
    originator: 'codex-tui',
    serializedBody: JSON.stringify({
      model: 'gpt-5.6-sol',
      input: [{ type: 'message', role: 'user', content: 'same request' }],
      stream: true,
    }),
    tenantId: 'kaiyan',
    sessionId: 'platform-session-1',
    cacheAffinityId: 'cache-affinity-1',
    clientRequestId: `request-${credentialGeneration}`,
  };
}

async function waitForSend(socket: FakeWebSocket): Promise<void> {
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
}

async function complete(
  pending: ReturnType<CodexResponsesWebSocketPool['execute']>,
  socket: FakeWebSocket,
  responseId: string,
): Promise<void> {
  socket.emit({ type: 'response.created', response: { id: responseId } });
  const result = await pending;
  socket.emit({
    type: 'response.completed',
    response: { id: responseId, model: 'gpt-5.6-sol', status: 'completed', output: [] },
  });
  await result.response.text();
}

describe('Codex credential generation fence', () => {
  it('迟到的旧 generation 不关闭或取代已建立的新 generation 连接', async () => {
    const currentSocket = new FakeWebSocket();
    const connector = connectorFor(currentSocket);
    connector.mockRejectedValue(new Error('旧 generation 不应建立连接'));
    const pool = new CodexResponsesWebSocketPool(connector);
    const currentPending = pool.execute(request(2));
    await waitForSend(currentSocket);

    await expect(pool.execute(request(1))).rejects.toMatchObject({
      reason: 'credential_generation_stale',
    });
    expect(connector).toHaveBeenCalledTimes(1);
    expect(currentSocket.readyState).toBe(1);

    await complete(currentPending, currentSocket, 'resp-generation-2');
    pool.close();
  });

  it('旧 generation 异步建连晚于新 generation 完成时不登记也不发送', async () => {
    let resolveStaleSocket!: (socket: EgressWebSocket) => void;
    const staleConnection = new Promise<EgressWebSocket>((resolve) => {
      resolveStaleSocket = resolve;
    });
    const staleSocket = new FakeWebSocket();
    const currentSocket = new FakeWebSocket();
    const connector = vi
      .fn()
      .mockReturnValueOnce(staleConnection)
      .mockResolvedValueOnce(
        currentSocket as unknown as EgressWebSocket,
      ) as unknown as EgressWebSocketConnector & ReturnType<typeof vi.fn>;
    const pool = new CodexResponsesWebSocketPool(connector);

    const stalePending = pool.execute(request(1));
    await vi.waitFor(() => expect(connector).toHaveBeenCalledTimes(1));
    const currentPending = pool.execute(request(2));
    await waitForSend(currentSocket);
    resolveStaleSocket(staleSocket as unknown as EgressWebSocket);

    await expect(stalePending).rejects.toMatchObject({ reason: 'credential_generation_stale' });
    expect(staleSocket.sent).toHaveLength(0);
    expect(staleSocket.readyState).toBe(3);

    await complete(currentPending, currentSocket, 'resp-generation-2');
    pool.close();
  });

  it('运行时关闭连接池不会清空 credential generation fence', async () => {
    const currentSocket = new FakeWebSocket();
    const connector = connectorFor(currentSocket);
    connector.mockRejectedValue(new Error('旧 generation 不应重新建连'));
    const pool = new CodexResponsesWebSocketPool(connector);
    const currentPending = pool.execute(request(2));
    await waitForSend(currentSocket);
    await complete(currentPending, currentSocket, 'resp-generation-2');
    pool.close();

    await expect(pool.execute(request(1))).rejects.toMatchObject({
      reason: 'credential_generation_stale',
    });
    expect(connector).toHaveBeenCalledTimes(1);
  });

  it('高 generation 关闭低 generation 在途连接时返回 stale', async () => {
    const staleSocket = new FakeWebSocket();
    const currentSocket = new FakeWebSocket();
    const pool = new CodexResponsesWebSocketPool(connectorFor(staleSocket, currentSocket));
    const stalePending = pool.execute(request(1));
    await waitForSend(staleSocket);
    const currentPending = pool.execute(request(2));

    await expect(stalePending).rejects.toMatchObject({ reason: 'credential_generation_stale' });
    await waitForSend(currentSocket);
    await complete(currentPending, currentSocket, 'resp-generation-2');
    pool.close();
  });

  it('旧连接关闭事件延迟时也不接收排队中的旧 generation 响应', async () => {
    const staleSocket = new FakeWebSocket();
    staleSocket.close = vi.fn();
    const currentSocket = new FakeWebSocket();
    const pool = new CodexResponsesWebSocketPool(connectorFor(staleSocket, currentSocket));
    const stalePending = pool.execute(request(1));
    await waitForSend(staleSocket);

    const currentPending = pool.execute(request(2));
    await waitForSend(currentSocket);
    staleSocket.emit({ type: 'response.created', response: { id: 'stale-response' } });

    await expect(stalePending).rejects.toMatchObject({ reason: 'credential_generation_stale' });
    await complete(currentPending, currentSocket, 'resp-generation-2');
    pool.close();
  });

  it('transport 不把 stale credential 降级为使用旧 bearer 的 HTTP 请求', async () => {
    const vault = new InMemorySecretVault();
    const config: CodexSubscriptionRuntimeConfig = { enabled: true, websocketEnabled: true };
    const manager = new CodexCredentialManager({ vault, getConfig: () => config });
    const credential = await manager.persistLogin({
      accessToken: jwt('acct-primary'),
      refreshToken: 'refresh-primary',
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    config.credentialRefs = [credential.credentialRef];
    const fetchMock = vi.fn();
    const websocketPool = {
      execute: vi.fn(async () => {
        throw new CodexWebSocketCredentialStaleError(credential.credentialRef, 1, 2);
      }),
    } as unknown as CodexResponsesWebSocketPool;
    const transport = new CodexSubscriptionResponsesTransport(
      manager,
      fetchMock as unknown as typeof fetch,
      websocketPool,
    );

    await expect(
      transport.execute({
        serializedBody: '{"model":"gpt-5.4","input":[]}',
        context: {
          runId: 'run-stale',
          sessionId: 'session-stale',
          tenantId: 'kaiyan',
          model: 'gpt-5.4',
          cwd: '/tmp/codex-workspace',
          channelContext: { channel: 'web' },
        },
        clientRequestId: 'stale-generation-request',
      }),
    ).rejects.toMatchObject({ reason: 'credential_generation_stale' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jwt(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    email: `${accountId}@example.com`,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })}.signature`;
}
