import http from 'http';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ClientDaemonGateway, type ClientDaemonGatewayOptions } from '../runtime/clientDaemonGateway.js';
import { ClientDaemonTransport } from '../runtime/clientDaemonTransport.js';
import { deriveClientDaemonHandId, parseClientDaemonMessage, serializeClientDaemonMessage, type ClientDaemonMessage } from '../runtime/clientDaemonProtocol.js';
import type { HandRecord, HandStatus, HandStore, RegisterHandInput } from '../runtime/handStore.js';
import type { ToolInvocationRequest } from '../runtime/handProtocol.js';

class MemoryHandStore implements HandStore {
  records = new Map<string, HandRecord>();
  async register(input: RegisterHandInput): Promise<HandRecord> {
    const now = new Date().toISOString();
    const existing = this.records.get(input.handId);
    const record: HandRecord = {
      handId: input.handId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      type: input.type,
      status: input.status ?? 'ready',
      endpoint: input.endpoint,
      capabilities: input.capabilities ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      leaseExpiresAt: input.leaseExpiresAt?.toISOString(),
      metadata: { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) },
    };
    this.records.set(input.handId, record);
    return record;
  }
  async updateStatus(handId: string, status: HandStatus, metadataPatch: Record<string, unknown> = {}): Promise<HandRecord | null> {
    const record = this.records.get(handId);
    if (!record) return null;
    const updated = { ...record, status, updatedAt: new Date().toISOString(), metadata: { ...record.metadata, ...metadataPatch } };
    this.records.set(handId, updated);
    return updated;
  }
  async claimProvisionRecovery(): Promise<HandRecord | null> { return null; }
  async completeProvisionAttempt(): Promise<HandRecord | null> { return null; }
  async completeProvisionRecovery(): Promise<HandRecord | null> { return null; }
  async get(handId: string): Promise<HandRecord | null> { return this.records.get(handId) ?? null; }
  async listBySession(sessionId: string): Promise<HandRecord[]> { return [...this.records.values()].filter((r) => r.sessionId === sessionId); }
  async listByWorkspace(workspaceId: string): Promise<HandRecord[]> { return [...this.records.values()].filter((r) => r.workspaceId === workspaceId); }
}

type GatewayOverrides = Partial<Pick<ClientDaemonGatewayOptions,
  'heartbeatTimeoutMs' | 'heartbeatScanIntervalMs' | 'disconnectGracePeriodMs' | 'logger'>>;

async function withGateway<T>(
  fn: (args: { url: string; transport: ClientDaemonTransport; handStore: MemoryHandStore; gateway: ClientDaemonGateway }) => Promise<T>,
  overrides: GatewayOverrides = {},
): Promise<T> {
  const server = http.createServer((_req, res) => res.end('ok'));
  const transport = new ClientDaemonTransport();
  const handStore = new MemoryHandStore();
  const gateway = new ClientDaemonGateway({
    transport,
    handStore,
    authToken: 'test-token',
    ...overrides,
  });
  gateway.attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server address');
  try {
    return await fn({ url: `ws://127.0.0.1:${address.port}/daemon?token=test-token`, transport, handStore, gateway });
  } finally {
    gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
}

function waitMessage(ws: WebSocket): Promise<ClientDaemonMessage> {
  return new Promise((resolve) => ws.once('message', (raw) => resolve(parseClientDaemonMessage(raw.toString()))));
}

async function waitUntil(predicate: () => boolean, { timeoutMs = 2_000, intervalMs = 10 } = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil timed out');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('ClientDaemonGateway', () => {
  it('registers hello as a ready client hand and marks unhealthy on disconnect', async () => {
    await withGateway(async ({ url, transport, handStore }) => {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      ws.send(serializeClientDaemonMessage({
        type: 'daemon_hello',
        protocolVersion: 1,
        daemonId: 'daemon-a',
        handId: 'hand-a',
        sessionId: 'session-a',
        workspaceId: 'workspace-a',
        capabilities: [],
      }));
      expect(await waitMessage(ws)).toMatchObject({ type: 'daemon_registered', handId: 'hand-a' });
      expect(transport.has('hand-a')).toBe(true);
      expect(await handStore.get('hand-a')).toMatchObject({ handId: 'hand-a', status: 'ready', type: 'client' });
      ws.close();
      await new Promise((resolve) => ws.once('close', resolve));
      await waitUntil(() => !transport.has('hand-a'));
      expect(transport.has('hand-a')).toBe(false);
      expect(await handStore.get('hand-a')).toMatchObject({ status: 'unhealthy' });
    });
  });

  it('keeps derived hand and request identities within the wire limit', async () => {
    await withGateway(async ({ url, transport }) => {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      const daemonId = 'd'.repeat(256);
      ws.send(serializeClientDaemonMessage({
        type: 'daemon_hello', protocolVersion: 1, daemonId, capabilities: [],
      }));
      const registered = await waitMessage(ws);
      expect(registered).toMatchObject({ type: 'daemon_registered', handId: deriveClientDaemonHandId(daemonId) });
      if (registered.type !== 'daemon_registered') throw new Error('daemon did not register');
      let requestId: string | undefined;
      ws.on('message', (raw) => {
        const message = parseClientDaemonMessage(raw.toString());
        if (message.type !== 'invoke_request') return;
        requestId = message.requestId;
        ws.send(serializeClientDaemonMessage({
          type: 'invoke_completed', protocolVersion: 1,
          requestId: message.requestId, invocationId: message.invocationId,
          response: { status: 'success', content: 'done' },
        }));
      });

      await expect(transport.invoke({
        toolName: 'Read', input: {},
        context: {
          handId: registered.handId,
          invocationId: 'logical-long-id',
          workspace: { id: 'w', root: '/tmp', executionTarget: 'client' },
        },
      })).resolves.toMatchObject({ status: 'success', content: 'done' });
      expect(requestId?.length).toBeLessThanOrEqual(256);
      ws.close();
    });
  });

  it('streams and cancels with legacy or correlation-only invocation identities', async () => {
    await withGateway(async ({ url, transport }) => {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      ws.send(serializeClientDaemonMessage({ type: 'daemon_hello', protocolVersion: 1, daemonId: 'daemon-b', handId: 'hand-b', capabilities: [] }));
      await waitMessage(ws);
      const receivedCancels: string[] = [];
      let invokeCount = 0;
      let pendingCorrelationInvoke: Extract<ClientDaemonMessage, { type: 'invoke_request' }> | undefined;
      ws.on('message', (raw) => {
        const msg = parseClientDaemonMessage(raw.toString());
        if (msg.type === 'invoke_request') {
          invokeCount += 1;
          expect((msg.request as ToolInvocationRequest).toolName).toBe('Shell');
          if (msg.invocationId === 'inv-correlation') {
            pendingCorrelationInvoke = msg;
            return;
          }
          ws.send(serializeClientDaemonMessage({ type: 'invoke_chunk', protocolVersion: 1, requestId: msg.requestId, invocationId: msg.invocationId, chunk: { type: 'output', channel: 'stdout', content: 'hello' } }));
          ws.send(serializeClientDaemonMessage({ type: 'invoke_chunk', protocolVersion: 1, requestId: msg.requestId, invocationId: msg.invocationId, chunk: { type: 'completed', response: { status: 'success', content: 'done' } } }));
        } else if (msg.type === 'cancel_request') {
          receivedCancels.push(msg.invocationId);
          ws.send(serializeClientDaemonMessage({ type: 'cancel_ack', protocolVersion: 1, requestId: msg.requestId, invocationId: msg.invocationId, accepted: true }));
          if (pendingCorrelationInvoke?.invocationId === msg.invocationId) {
            ws.send(serializeClientDaemonMessage({
              type: 'invoke_completed', protocolVersion: 1,
              requestId: pendingCorrelationInvoke.requestId, invocationId: msg.invocationId,
              response: { status: 'error', error: 'cancelled' },
            }));
          }
        }
      });

      const chunks = [];
      for await (const chunk of transport.invokeStream({
        toolName: 'Shell',
        input: { command: 'echo hello', handId: 'hand-b' },
        context: { handId: 'hand-b', invocationId: 'inv-b', workspace: { id: 'w', root: '/tmp', executionTarget: 'client' } },
      })) chunks.push(chunk);
      expect(chunks).toEqual([
        { type: 'output', channel: 'stdout', content: 'hello' },
        { type: 'completed', response: { status: 'success', content: 'done' } },
      ]);

      const controller = new AbortController();
      const correlationChunksPromise = (async () => {
        const correlationChunks = [];
        for await (const chunk of transport.invokeStream({
          toolName: 'Shell', input: { command: 'sleep 10' },
          context: {
            signal: controller.signal,
            correlation: { version: 1, handId: 'hand-b', invocationId: 'inv-correlation', attemptId: 'attempt-1' },
            workspace: { id: 'w', root: '/tmp', executionTarget: 'client' },
          },
        })) correlationChunks.push(chunk);
        return correlationChunks;
      })();
      await waitUntil(() => Boolean(pendingCorrelationInvoke));
      controller.abort();
      expect(await correlationChunksPromise).toEqual([
        { type: 'completed', response: { status: 'error', error: 'cancelled' } },
      ]);
      expect(receivedCancels).toEqual(['inv-correlation']);

      const preAborted = new AbortController();
      preAborted.abort();
      expect(await transport.invoke({
        toolName: 'Shell', input: { command: 'should-not-run' },
        context: {
          signal: preAborted.signal,
          correlation: { version: 1, handId: 'hand-b', invocationId: 'inv-pre-aborted', attemptId: 'attempt-pre' },
          workspace: { id: 'w', root: '/tmp', executionTarget: 'client' },
        },
      })).toMatchObject({ status: 'error', error: 'client daemon invocation aborted before dispatch' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(invokeCount).toBe(2);
      expect(receivedCancels).toEqual(['inv-correlation']);
      ws.close();
    });
  });

  it('rejects unsafe hello identities without echoing them into gateway logs', async () => {
    const warnings: string[] = [];
    await withGateway(async ({ url }) => {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      const secret = 'secret-token\n[FORGED]';
      const closed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      ws.send(JSON.stringify({
        type: 'daemon_hello', protocolVersion: 1, daemonId: secret, handId: secret, capabilities: [],
      }));
      await closed;
      expect(warnings).toEqual(['Client daemon hello rejected']);
      expect(JSON.stringify(warnings)).not.toContain(secret);
    }, { logger: { warn: (message) => warnings.push(message) } });
  });

  it('sanitizes remote cancel errors before logging them', async () => {
    const warnings: string[] = [];
    await withGateway(async ({ url, transport }) => {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      ws.send(serializeClientDaemonMessage({
        type: 'daemon_hello', protocolVersion: 1, daemonId: 'daemon-cancel-log', handId: 'hand-cancel-log', capabilities: [],
      }));
      await waitMessage(ws);
      const secret = 'secret-token\n[FORGED]';
      let cancelCount = 0;
      ws.on('message', (raw) => {
        const message = parseClientDaemonMessage(raw.toString());
        if (message.type !== 'cancel_request') return;
        cancelCount += 1;
        if (cancelCount === 1) {
          ws.send(serializeClientDaemonMessage({
            type: 'cancel_ack', protocolVersion: 1,
            requestId: message.requestId, invocationId: 'wrong-invocation',
            accepted: true, message: secret,
          }));
        } else {
          ws.send(serializeClientDaemonMessage({
            type: 'daemon_error', protocolVersion: 1,
            requestId: message.requestId, invocationId: 'wrong-invocation',
            message: secret,
          }));
        }
      });

      await transport.cancel('hand-cancel-log', 'invocation-1');
      await transport.cancel('hand-cancel-log', 'invocation-2');
      expect(warnings).toEqual([
        'Client daemon cancel delivery failed',
        'Client daemon cancel delivery failed',
      ]);
      expect(JSON.stringify(warnings)).not.toContain(secret);
      ws.close();
    }, { logger: { warn: (message) => warnings.push(message) } });
  });

  it('does not echo malformed correlation keys or versions into gateway logs or responses', async () => {
    const warnings: string[] = [];
    await withGateway(async ({ url }) => {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      ws.send(serializeClientDaemonMessage({
        type: 'daemon_hello', protocolVersion: 1, daemonId: 'daemon-safe-log', handId: 'hand-safe-log', capabilities: [],
      }));
      await waitMessage(ws);

      const secret = 'secret-token\\n[FORGED]';
      const keyResponsePromise = waitMessage(ws);
      ws.send(JSON.stringify({
        type: 'invoke_request', protocolVersion: 1, requestId: 'malformed-1', invocationId: 'logical-1',
        request: {
          toolName: 'Read', input: {},
          context: { correlation: { version: 1, [secret]: 'value' }, workspace: {} },
        },
      }));
      const keyResponse = await keyResponsePromise;
      expect(keyResponse).toEqual({ type: 'daemon_error', protocolVersion: 1, message: 'invalid client daemon message' });

      const versionSecret = 'version-secret\n[FORGED]';
      const versionResponsePromise = waitMessage(ws);
      ws.send(JSON.stringify({
        type: 'invoke_request', protocolVersion: 1, requestId: 'malformed-2', invocationId: 'logical-2',
        request: {
          toolName: 'Read', input: {},
          context: { correlation: { version: versionSecret }, workspace: {} },
        },
      }));
      const versionResponse = await versionResponsePromise;
      expect(versionResponse).toEqual({ type: 'daemon_error', protocolVersion: 1, message: 'invalid client daemon message' });
      expect(JSON.stringify({ warnings, keyResponse, versionResponse })).not.toMatch(/secret-token|version-secret|FORGED/);
      expect(warnings).toEqual(['Client daemon message rejected', 'Client daemon message rejected']);
      ws.close();
    }, { logger: { warn: (message) => warnings.push(message) } });
  });

  it('forces close on heartbeat timeout, fails pending invokes, and marks hand unhealthy with reason', async () => {
    await withGateway(
      async ({ url, transport, handStore, gateway }) => {
        const ws = new WebSocket(url);
        await waitOpen(ws);
        ws.send(serializeClientDaemonMessage({
          type: 'daemon_hello',
          protocolVersion: 1,
          daemonId: 'daemon-stall',
          handId: 'hand-stall',
          capabilities: [],
        }));
        const registered = await waitMessage(ws);
        expect(registered).toMatchObject({ type: 'daemon_registered', handId: 'hand-stall' });

        // daemon never responds to invoke; we start an invocation to verify it gets failed on heartbeat-driven close.
        const streamPromise = (async () => {
          const chunks = [] as unknown[];
          for await (const chunk of transport.invokeStream({
            toolName: 'Shell',
            input: { command: 'sleep 999', handId: 'hand-stall' },
            context: { handId: 'hand-stall', invocationId: 'inv-stall', workspace: { id: 'w', root: '/tmp', executionTarget: 'client' } },
          })) chunks.push(chunk);
          return chunks;
        })();

        // Let the async generator actually dispatch invoke_request before we yank the connection.
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Wait for the close event triggered by manual scanner invocation.
        const closePromise = new Promise<{ code: number }>((resolve) =>
          ws.once('close', (code) => resolve({ code })),
        );

        // Pretend a lot of time has passed. heartbeatTimeoutMs=200ms, so 10s in the "future"
        // is well past timeout for any connection that has not heartbeat'd.
        gateway.scanHeartbeatsOnce(Date.now() + 10_000);

        const closeInfo = await closePromise;
        expect(closeInfo.code).toBe(1011);

        // Pending invoke must be failed; final chunk is a completed error.
        const chunks = await streamPromise;
        expect(chunks.at(-1)).toMatchObject({ type: 'completed', response: { status: 'error' } });

        await waitUntil(() => !transport.has('hand-stall'));
        expect(transport.has('hand-stall')).toBe(false);
        const record = await handStore.get('hand-stall');
        expect(record).toMatchObject({ status: 'unhealthy' });
        expect(record?.metadata?.disconnectReason).toMatch(/^heartbeat_timeout:/);
      },
      { heartbeatTimeoutMs: 200, heartbeatScanIntervalMs: 50 },
    );
  });

  it('keeps connection alive while heartbeat messages arrive', async () => {
    await withGateway(
      async ({ url, transport, gateway }) => {
        const ws = new WebSocket(url);
        await waitOpen(ws);
        ws.send(serializeClientDaemonMessage({
          type: 'daemon_hello',
          protocolVersion: 1,
          daemonId: 'daemon-live',
          handId: 'hand-live',
          capabilities: [],
        }));
        await waitMessage(ws);

        // Send a heartbeat and immediately scan with a `now` past the timeout but not past `lastSeenAt + timeout`.
        ws.send(serializeClientDaemonMessage({ type: 'daemon_heartbeat', protocolVersion: 1, daemonId: 'daemon-live', handId: 'hand-live' }));
        // Give the server a tick to process the heartbeat.
        await new Promise((resolve) => setTimeout(resolve, 50));
        gateway.scanHeartbeatsOnce(Date.now() + 100); // 100ms after heartbeat: under 200ms timeout
        expect(transport.has('hand-live')).toBe(true);

        // Now jump well past the timeout to confirm scanner does kick when truly stale.
        gateway.scanHeartbeatsOnce(Date.now() + 5_000);
        await waitUntil(() => !transport.has('hand-live'));
        expect(transport.has('hand-live')).toBe(false);
      },
      { heartbeatTimeoutMs: 200, heartbeatScanIntervalMs: 50 },
    );
  });
});
