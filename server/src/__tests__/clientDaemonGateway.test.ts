import http from 'http';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ClientDaemonGateway, type ClientDaemonGatewayOptions } from '../runtime/clientDaemonGateway.js';
import { ClientDaemonTransport } from '../runtime/clientDaemonTransport.js';
import { parseClientDaemonMessage, serializeClientDaemonMessage, type ClientDaemonMessage } from '../runtime/clientDaemonProtocol.js';
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
  async get(handId: string): Promise<HandRecord | null> { return this.records.get(handId) ?? null; }
  async listBySession(sessionId: string): Promise<HandRecord[]> { return [...this.records.values()].filter((r) => r.sessionId === sessionId); }
  async listByWorkspace(workspaceId: string): Promise<HandRecord[]> { return [...this.records.values()].filter((r) => r.workspaceId === workspaceId); }
}

type GatewayOverrides = Partial<Pick<ClientDaemonGatewayOptions, 'heartbeatTimeoutMs' | 'heartbeatScanIntervalMs' | 'logger'>>;

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

  it('streams invoke chunks through ClientDaemonTransport and delivers cancel requests', async () => {
    await withGateway(async ({ url, transport }) => {
      const ws = new WebSocket(url);
      await waitOpen(ws);
      ws.send(serializeClientDaemonMessage({ type: 'daemon_hello', protocolVersion: 1, daemonId: 'daemon-b', handId: 'hand-b', capabilities: [] }));
      await waitMessage(ws);
      const receivedCancels: string[] = [];
      ws.on('message', (raw) => {
        const msg = parseClientDaemonMessage(raw.toString());
        if (msg.type === 'invoke_request') {
          expect((msg.request as ToolInvocationRequest).toolName).toBe('Shell');
          ws.send(serializeClientDaemonMessage({ type: 'invoke_chunk', protocolVersion: 1, requestId: msg.requestId, invocationId: msg.invocationId, chunk: { type: 'output', channel: 'stdout', content: 'hello' } }));
          ws.send(serializeClientDaemonMessage({ type: 'invoke_completed', protocolVersion: 1, requestId: msg.requestId, invocationId: msg.invocationId, response: { status: 'success', content: 'done' } }));
        } else if (msg.type === 'cancel_request') {
          receivedCancels.push(msg.invocationId);
          ws.send(serializeClientDaemonMessage({ type: 'cancel_ack', protocolVersion: 1, requestId: msg.requestId, invocationId: msg.invocationId, accepted: true }));
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

      await transport.cancel('hand-b', 'inv-b');
      expect(receivedCancels).toEqual(['inv-b']);
      ws.close();
    });
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

  // A5: vault rotation hot-update — setAuthToken makes the gateway reject any
  // subsequent connection that still presents the old token, while accepting
  // connections that present the new token. Existing connections are kept (we
  // don't assert on that here; the daemon will naturally reconnect during
  // rotation).
  it('setAuthToken hot-rotates the accepted bearer for new connections', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const transport = new ClientDaemonTransport();
    const handStore = new MemoryHandStore();
    const gateway = new ClientDaemonGateway({
      transport,
      handStore,
      authToken: 'old-token',
    });
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const port = address.port;

    try {
      // Initial connection with old token succeeds.
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}/daemon?token=old-token`);
      await waitOpen(ws1);
      ws1.close();

      // Hot-rotate to a new token.
      gateway.setAuthToken('new-token-987');

      // Old token now rejected at the upgrade handshake (401).
      const wsOld = new WebSocket(`ws://127.0.0.1:${port}/daemon?token=old-token`);
      await new Promise<void>((resolve) => {
        wsOld.once('error', () => resolve());
        wsOld.once('unexpected-response', (_req, res) => {
          expect(res.statusCode).toBe(401);
          resolve();
        });
      });

      // New token accepted.
      const wsNew = new WebSocket(`ws://127.0.0.1:${port}/daemon?token=new-token-987`);
      await waitOpen(wsNew);
      wsNew.close();

      // Disable auth entirely (dev mode) — any connection accepted.
      gateway.setAuthToken(undefined);
      const wsNoAuth = new WebSocket(`ws://127.0.0.1:${port}/daemon`);
      await waitOpen(wsNoAuth);
      wsNoAuth.close();
    } finally {
      gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // C2: grace-period reconnect — when the socket drops with pending invokes
  // and the same handId reconnects within the grace window, the pendingInvokes
  // Map is preserved on the connection so a subsequent invoke_completed from
  // the new socket resolves the original caller.
  it('preserves pending invokes across a grace-period reconnect', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const transport = new ClientDaemonTransport();
    const handStore = new MemoryHandStore();
    const gateway = new ClientDaemonGateway({
      transport,
      handStore,
      authToken: 'gp-token',
      disconnectGracePeriodMs: 2_000,
    });
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const port = address.port;

    try {
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}/daemon?token=gp-token`);
      await waitOpen(ws1);
      ws1.send(serializeClientDaemonMessage({
        type: 'daemon_hello',
        protocolVersion: 1,
        daemonId: 'd-gp',
        handId: 'hand-gp',
        capabilities: [],
      }));
      await waitMessage(ws1);

      // Issue invoke through the transport; daemon side does NOT respond yet.
      // ws1.on('message') captures the invoke_request so the test can replay
      // its requestId/invocationId from the reconnected ws2.
      const captured: { requestId?: string; invocationId?: string } = {};
      const sawInvokeRequest = new Promise<void>((resolve) => {
        ws1.on('message', (raw) => {
          const msg = parseClientDaemonMessage(raw.toString());
          if (msg.type === 'invoke_request') {
            captured.requestId = msg.requestId;
            captured.invocationId = msg.invocationId;
            resolve();
          }
        });
      });

      const requestPromise = transport.invoke({
        toolName: 'noop',
        input: {},
        context: {
          handId: 'hand-gp',
          workspace: { id: 'ws', root: '/tmp', sessionId: 's-gp', executionTarget: 'client' } as any,
          invocationId: 'inv-gp',
        },
      });
      await sawInvokeRequest;

      // Drop the socket without waiting for completion.
      ws1.terminate();
      // hand should NOT be marked unhealthy yet — we're inside the grace window.
      await waitUntil(() => !!handStore.records.get('hand-gp'), { timeoutMs: 1_000 });
      expect(handStore.records.get('hand-gp')?.status).toBe('ready');

      // Reconnect with the same handId / daemonId.
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/daemon?token=gp-token`);
      await waitOpen(ws2);
      ws2.send(serializeClientDaemonMessage({
        type: 'daemon_hello',
        protocolVersion: 1,
        daemonId: 'd-gp',
        handId: 'hand-gp',
        capabilities: [],
        resumeInvocations: [{ invocationId: 'inv-gp' }],
      }));
      const ack = await waitMessage(ws2);
      expect(ack.type).toBe('daemon_registered');

      // Replay invoke_completed for the captured requestId — the gateway-side
      // pendingInvokes Map (alive across the drop) routes it to the original
      // requestPromise reader.
      ws2.send(serializeClientDaemonMessage({
        type: 'invoke_completed',
        protocolVersion: 1,
        requestId: captured.requestId!,
        invocationId: captured.invocationId!,
        response: { status: 'success', content: 'ok' } as any,
      }));

      const response = await requestPromise;
      expect(response.status).toBe('success');
      ws2.close();
    } finally {
      gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fails pending invokes when the grace period elapses without a reconnect', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const transport = new ClientDaemonTransport();
    const handStore = new MemoryHandStore();
    const gateway = new ClientDaemonGateway({
      transport,
      handStore,
      authToken: 'gp-token-fail',
      disconnectGracePeriodMs: 80,
    });
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const port = address.port;

    try {
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}/daemon?token=gp-token-fail`);
      await waitOpen(ws1);
      ws1.send(serializeClientDaemonMessage({
        type: 'daemon_hello',
        protocolVersion: 1,
        daemonId: 'd-gp-x',
        handId: 'hand-gp-x',
        capabilities: [],
      }));
      await waitMessage(ws1);

      const sawInvokeRequest = new Promise<void>((resolve) => {
        ws1.on('message', (raw) => {
          const msg = parseClientDaemonMessage(raw.toString());
          if (msg.type === 'invoke_request') resolve();
        });
      });

      const requestPromise = transport.invoke({
        toolName: 'noop',
        input: {},
        context: {
          handId: 'hand-gp-x',
          workspace: { id: 'ws', root: '/tmp', sessionId: 's', executionTarget: 'client' } as any,
          invocationId: 'inv-fail',
        },
      });
      await sawInvokeRequest;

      ws1.terminate();

      // queue.fail() rethrows through connection.invoke's async-iterator;
      // transport.invoke surfaces it as a rejected promise (rather than an
      // error-status response) because connection.invoke doesn't catch.
      await expect(requestPromise).rejects.toThrow(/grace period|connection closed/);
      // Hand now unhealthy after grace timeout.
      await waitUntil(() => handStore.records.get('hand-gp-x')?.status === 'unhealthy', { timeoutMs: 1_000 });
      expect(handStore.records.get('hand-gp-x')?.status).toBe('unhealthy');
    } finally {
      gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // C3: capability resync — when the reconnect hello declares the same
  // capabilitiesVersion the connection still has, the gateway keeps the
  // cached HandCapability[] in place and emits capabilityResync='skipped'.
  // A version mismatch updates the cached list.
  it('skips capability rewrite on reconnect when capabilitiesVersion matches', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const transport = new ClientDaemonTransport();
    const handStore = new MemoryHandStore();
    const gateway = new ClientDaemonGateway({
      transport,
      handStore,
      authToken: 'c3-token',
      disconnectGracePeriodMs: 2_000,
    });
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const port = address.port;

    const initialCapabilities = [{
      name: 'workspace',
      description: 'initial caps',
      tools: [],
      constraints: [],
      risk: 'workspace_write' as const,
    }];
    const changedCapabilities = [{
      name: 'workspace',
      description: 'shrunk caps',
      tools: [],
      constraints: [],
      risk: 'safe' as const,
    }];

    try {
      // Initial connect — version=A
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}/daemon?token=c3-token`);
      await waitOpen(ws1);
      ws1.send(serializeClientDaemonMessage({
        type: 'daemon_hello',
        protocolVersion: 1,
        daemonId: 'd-c3',
        handId: 'hand-c3',
        capabilities: initialCapabilities,
        capabilitiesVersion: 'cap-A',
      }));
      await waitMessage(ws1);
      // Force a drop, then reconnect with capabilitiesVersion=A but a
      // (deliberately) different capabilities list. The matching version
      // means the gateway must KEEP the original list.
      const captured: { requestId?: string; invocationId?: string } = {};
      const sawInvokeRequest = new Promise<void>((resolve) => {
        ws1.on('message', (raw) => {
          const msg = parseClientDaemonMessage(raw.toString());
          if (msg.type === 'invoke_request') {
            captured.requestId = msg.requestId;
            captured.invocationId = msg.invocationId;
            resolve();
          }
        });
      });
      const pending = transport.invoke({
        toolName: 'noop',
        input: {},
        context: {
          handId: 'hand-c3',
          workspace: { id: 'ws', root: '/tmp', sessionId: 's', executionTarget: 'client' } as any,
          invocationId: 'inv-c3',
        },
      });
      await sawInvokeRequest;
      ws1.terminate();

      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/daemon?token=c3-token`);
      await waitOpen(ws2);
      ws2.send(serializeClientDaemonMessage({
        type: 'daemon_hello',
        protocolVersion: 1,
        daemonId: 'd-c3',
        handId: 'hand-c3',
        capabilities: changedCapabilities, // would be wrong to apply
        capabilitiesVersion: 'cap-A',     // …but version matches, so keep old
      }));
      await waitMessage(ws2);

      // Verify gateway state: capability resync skipped.
      const reconnectedHand = handStore.records.get('hand-c3');
      expect(reconnectedHand?.metadata.capabilityResync).toBe('skipped_same_version');
      expect(reconnectedHand?.metadata.capabilitiesVersion).toBe('cap-A');

      // Drain the pending invoke from the new socket using the requestId we
      // captured on ws1 — the gateway-side pendingInvokes Map outlived the
      // socket churn so an invoke_completed on ws2 still routes correctly.
      ws2.send(serializeClientDaemonMessage({
        type: 'invoke_completed',
        protocolVersion: 1,
        requestId: captured.requestId!,
        invocationId: captured.invocationId!,
        response: { status: 'success', content: 'ok' } as any,
      }));
      await pending;
      ws2.close();
    } finally {
      gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('updates capabilities when reconnect hello reports a new version', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    const transport = new ClientDaemonTransport();
    const handStore = new MemoryHandStore();
    const gateway = new ClientDaemonGateway({
      transport,
      handStore,
      authToken: 'c3b-token',
      disconnectGracePeriodMs: 2_000,
    });
    gateway.attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    const port = address.port;

    try {
      const ws1 = new WebSocket(`ws://127.0.0.1:${port}/daemon?token=c3b-token`);
      await waitOpen(ws1);
      ws1.send(serializeClientDaemonMessage({
        type: 'daemon_hello',
        protocolVersion: 1,
        daemonId: 'd-c3b',
        handId: 'hand-c3b',
        capabilities: [{ name: 'workspace', description: 'v1', tools: [], constraints: [], risk: 'safe' }],
        capabilitiesVersion: 'cap-v1',
      }));
      await waitMessage(ws1);

      const c3bCaptured: { requestId?: string; invocationId?: string } = {};
      const sawInvokeRequest = new Promise<void>((resolve) => {
        ws1.on('message', (raw) => {
          const msg = parseClientDaemonMessage(raw.toString());
          if (msg.type === 'invoke_request') {
            c3bCaptured.requestId = msg.requestId;
            c3bCaptured.invocationId = msg.invocationId;
            resolve();
          }
        });
      });
      const pending = transport.invoke({
        toolName: 'noop',
        input: {},
        context: {
          handId: 'hand-c3b',
          workspace: { id: 'ws', root: '/tmp', sessionId: 's', executionTarget: 'client' } as any,
          invocationId: 'inv-c3b',
        },
      });
      await sawInvokeRequest;
      ws1.terminate();

      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/daemon?token=c3b-token`);
      await waitOpen(ws2);
      ws2.send(serializeClientDaemonMessage({
        type: 'daemon_hello',
        protocolVersion: 1,
        daemonId: 'd-c3b',
        handId: 'hand-c3b',
        capabilities: [{ name: 'workspace', description: 'v2', tools: [], constraints: [], risk: 'dangerous' }],
        capabilitiesVersion: 'cap-v2',
      }));
      await waitMessage(ws2);
      expect(handStore.records.get('hand-c3b')?.metadata.capabilityResync).toBe('updated');
      expect(handStore.records.get('hand-c3b')?.metadata.capabilitiesVersion).toBe('cap-v2');
      ws2.send(serializeClientDaemonMessage({
        type: 'invoke_completed',
        protocolVersion: 1,
        requestId: c3bCaptured.requestId!,
        invocationId: c3bCaptured.invocationId!,
        response: { status: 'success', content: 'ok' } as any,
      }));
      await pending;
      ws2.close();
    } finally {
      gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
