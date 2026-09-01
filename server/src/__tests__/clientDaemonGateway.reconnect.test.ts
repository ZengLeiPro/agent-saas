import http from 'http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ClientDaemonGateway, type ClientDaemonGatewayOptions } from '../runtime/clientDaemonGateway.js';
import { ClientDaemonRunner } from '../runtime/clientDaemonRunner.js';
import { InMemoryClientDaemonRegistry, issueClientDaemonDeviceCredential } from '../runtime/clientDaemonRegistry.js';
import { ClientDaemonTransport } from '../runtime/clientDaemonTransport.js';
import { deriveClientDaemonHandId, deriveTenantQualifiedClientDaemonHandId, parseClientDaemonMessage, serializeClientDaemonMessage, type ClientDaemonMessage } from '../runtime/clientDaemonProtocol.js';
import type { HandRecord, HandStatus, HandStore, RegisterHandInput } from '../runtime/handStore.js';
import type { ToolInvocationRequest, ToolInvocationResponse } from '../runtime/handProtocol.js';
import { InMemorySecretVault } from '../security/secretVault.js';

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
  'heartbeatTimeoutMs' | 'heartbeatScanIntervalMs' | 'disconnectGracePeriodMs' | 'logger'
  | 'deviceRegistry' | 'deviceSecretVault' | 'resolveDaemonTenantId'>>;

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
    resolveDaemonTenantId: () => 'tenant-test',
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

const qualifiedHandId = (rawHandId: string, tenantId = 'tenant-test') =>
  deriveTenantQualifiedClientDaemonHandId(tenantId, rawHandId);

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

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('ClientDaemonGateway reconnect lifecycle', () => {
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
      resolveDaemonTenantId: () => 'tenant-test',
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

  it('replaces a duplicate live socket without corrupting the latest grace generation', async () => {
    await withGateway(async ({ url, transport }) => {
      const ws1 = new WebSocket(url);
      await waitOpen(ws1);
      ws1.send(serializeClientDaemonMessage({
        type: 'daemon_hello', protocolVersion: 1,
        daemonId: 'daemon-generation', handId: 'hand-generation', capabilities: [],
      }));
      await waitMessage(ws1);
      const firstRequest = new Promise<void>((resolve) => ws1.on('message', (raw) => {
        if (parseClientDaemonMessage(raw.toString()).type === 'invoke_request') resolve();
      }));
      const firstPending = transport.invoke({
        toolName: 'Write', input: {},
        context: {
          handId: qualifiedHandId('hand-generation'), invocationId: 'logical-generation-old',
          workspace: { id: 'w', root: '/tmp', executionTarget: 'client' },
        },
      });
      await firstRequest;

      const firstRejected = expect(firstPending).rejects.toThrow('connection replaced');
      const ws2 = new WebSocket(url);
      await waitOpen(ws2);
      ws2.send(serializeClientDaemonMessage({
        type: 'daemon_hello', protocolVersion: 1,
        daemonId: 'daemon-generation', handId: 'hand-generation', capabilities: [],
      }));
      await waitMessage(ws2);
      await firstRejected;

      let secondRequest: Extract<ClientDaemonMessage, { type: 'invoke_request' }> | undefined;
      const sawSecondRequest = new Promise<void>((resolve) => ws2.on('message', (raw) => {
        const message = parseClientDaemonMessage(raw.toString());
        if (message.type === 'invoke_request') {
          secondRequest = message;
          resolve();
        }
      }));
      const secondPending = transport.invoke({
        toolName: 'Write', input: {},
        context: {
          handId: qualifiedHandId('hand-generation'), invocationId: 'logical-generation-new',
          workspace: { id: 'w', root: '/tmp', executionTarget: 'client' },
        },
      });
      await sawSecondRequest;
      ws2.terminate();

      const ws3 = new WebSocket(url);
      await waitOpen(ws3);
      ws3.send(serializeClientDaemonMessage({
        type: 'daemon_hello', protocolVersion: 1,
        daemonId: 'daemon-generation', handId: 'hand-generation', capabilities: [],
        resumeInvocations: [{ invocationId: 'logical-generation-new' }],
      }));
      await waitMessage(ws3);
      ws3.send(serializeClientDaemonMessage({
        type: 'invoke_completed', protocolVersion: 1,
        requestId: secondRequest!.requestId,
        invocationId: secondRequest!.invocationId,
        response: { status: 'success', content: 'latest-generation' },
      }));
      await expect(secondPending).resolves.toMatchObject({ status: 'success', content: 'latest-generation' });
      ws3.close();
    }, { disconnectGracePeriodMs: 2_000 });
  });

  // 显式阻塞重连 hello 认证，覆盖 socket OPEN 到 daemon_registered 之间的完成消息竞态；coverage 并发下放宽超时。
  it('resumes a built-in runner invocation across a grace-period reconnect', async () => {
    const vault = new InMemorySecretVault();
    const registry = new InMemoryClientDaemonRegistry();
    const { bearer } = await issueClientDaemonDeviceCredential({
      registry,
      vault,
      input: { deviceId: 'daemon-grace-runner' },
    });
    let resolveReconnectAuthentication: (() => void) | undefined;
    let markReconnectAuthenticationStarted: (() => void) | undefined;
    const reconnectAuthenticationStarted = new Promise<void>((resolve) => { markReconnectAuthenticationStarted = resolve; });
    const reconnectAuthentication = new Promise<void>((resolve) => { resolveReconnectAuthentication = resolve; });
    const getDevice = registry.get.bind(registry);
    let authAttempts = 0; // authenticate + authoritative tenant lookup per accepted hello
    registry.get = async (deviceId) => {
      authAttempts += 1;
      if (authAttempts === 3) {
        markReconnectAuthenticationStarted?.();
        await reconnectAuthentication;
      }
      return getDevice(deviceId);
    };

    await withGateway(async ({ url, transport }) => {
      let resolveExecution: ((response: ToolInvocationResponse) => void) | undefined;
      let executionSignal: AbortSignal | undefined;
      const provider = {
        execute: vi.fn(async (request: ToolInvocationRequest) => new Promise<ToolInvocationResponse>((resolve) => {
          executionSignal = request.context.signal;
          resolveExecution = resolve;
        })),
        listInternalTools: () => [],
      };
      const runner = new ClientDaemonRunner({
        url,
        daemonId: 'daemon-grace-runner',
        handId: 'hand-grace-runner',
        workspaceRoot: await mkdtemp(join(tmpdir(), 'client-daemon-grace-runner-')),
        reconnectDelayMs: 50,
        provider,
        authToken: bearer,
      });
      const run = runner.runForever();
      try {
        await waitUntil(() => transport.has(qualifiedHandId('hand-grace-runner')));
        const pending = transport.invoke({
          toolName: 'Write', input: {},
          context: {
            handId: qualifiedHandId('hand-grace-runner'), invocationId: 'logical-grace-runner',
            correlation: { version: 1, handId: qualifiedHandId('hand-grace-runner'), invocationId: 'logical-grace-runner', attemptId: 'attempt-grace-runner' },
            workspace: { id: 'w', root: '/tmp', executionTarget: 'client' },
          },
        });
        await waitUntil(() => provider.execute.mock.calls.length === 1);
        const internal = runner as unknown as {
          ws?: WebSocket;
          pendingCompletions?: Map<string, ClientDaemonMessage>;
        };
        const disconnectedSocket = internal.ws!;
        disconnectedSocket.terminate();
        await waitUntil(() => executionSignal?.aborted === true);
        await waitUntil(() => internal.ws !== disconnectedSocket && internal.ws?.readyState === WebSocket.OPEN);
        await withTimeout(reconnectAuthenticationStarted, 'reconnect authentication start');

        // 执行可能在 gateway 完成异步 daemon_hello 认证前结束；终态必须等待 daemon_registered 后补发。
        resolveExecution?.({ status: 'success', content: 'resumed' });
        await waitUntil(() => internal.pendingCompletions?.size === 1);
        resolveReconnectAuthentication?.();
        await expect(withTimeout(pending, 'resumed invocation')).resolves.toMatchObject({ status: 'success', content: 'resumed' });
        expect(provider.execute).toHaveBeenCalledTimes(1);
      } finally {
        resolveReconnectAuthentication?.();
        resolveExecution?.({ status: 'error', error: 'test cleanup' });
        await withTimeout(runner.stop(), 'runner stop');
        await withTimeout(run, 'runner loop stop');
      }
    }, {
      disconnectGracePeriodMs: 2_000,
      deviceRegistry: registry,
      deviceSecretVault: vault,
    });
  }, 60_000);

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
      resolveDaemonTenantId: () => 'tenant-test',
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
          handId: qualifiedHandId('hand-gp'),
          workspace: { id: 'ws', root: '/tmp', sessionId: 's-gp', executionTarget: 'client' } as any,
          invocationId: 'inv-gp',
        },
      });
      await sawInvokeRequest;

      // Drop the socket without waiting for completion.
      ws1.terminate();
      // hand should NOT be marked unhealthy yet — we're inside the grace window.
      await waitUntil(() => !!handStore.records.get(qualifiedHandId('hand-gp')), { timeoutMs: 1_000 });
      expect(handStore.records.get(qualifiedHandId('hand-gp'))?.status).toBe('ready');

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
      resolveDaemonTenantId: () => 'tenant-test',
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
          handId: qualifiedHandId('hand-gp-x'),
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
      await waitUntil(() => handStore.records.get(qualifiedHandId('hand-gp-x'))?.status === 'unhealthy', { timeoutMs: 1_000 });
      expect(handStore.records.get(qualifiedHandId('hand-gp-x'))?.status).toBe('unhealthy');
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
      resolveDaemonTenantId: () => 'tenant-test',
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
          handId: qualifiedHandId('hand-c3'),
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
        resumeInvocations: [{ invocationId: 'inv-c3' }],
      }));
      await waitMessage(ws2);

      // Verify gateway state: capability resync skipped.
      const reconnectedHand = handStore.records.get(qualifiedHandId('hand-c3'));
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
      resolveDaemonTenantId: () => 'tenant-test',
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
          handId: qualifiedHandId('hand-c3b'),
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
        resumeInvocations: [{ invocationId: 'inv-c3b' }],
      }));
      await waitMessage(ws2);
      expect(handStore.records.get(qualifiedHandId('hand-c3b'))?.metadata.capabilityResync).toBe('updated');
      expect(handStore.records.get(qualifiedHandId('hand-c3b'))?.metadata.capabilitiesVersion).toBe('cap-v2');
      expect(handStore.records.get(qualifiedHandId('hand-c3b'))?.capabilities[0]?.risk).toBe('dangerous');
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

});
