import { describe, expect, it, vi } from 'vitest';

import { HandHealthScanner } from '../runtime/handHealthScanner.js';
import type { HandRecord, HandStatus, HandStore, RegisterHandInput } from '../runtime/handStore.js';
import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from '../runtime/types.js';

function makeHand(overrides: Partial<HandRecord> & { handId: string }): HandRecord {
  return {
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    type: 'server-remote',
    status: 'ready',
    endpoint: 'http://hand.example/api',
    capabilities: [],
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

class InMemoryHandStore implements HandStore {
  readonly hands = new Map<string, HandRecord>();

  async register(input: RegisterHandInput): Promise<HandRecord> {
    const record: HandRecord = {
      handId: input.handId,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      type: input.type,
      status: input.status ?? 'ready',
      endpoint: input.endpoint,
      capabilities: input.capabilities ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: input.metadata ?? {},
    };
    this.hands.set(input.handId, record);
    return record;
  }

  async updateStatus(handId: string, status: HandStatus, metadataPatch: Record<string, unknown> = {}): Promise<HandRecord | null> {
    const hand = this.hands.get(handId);
    if (!hand) return null;
    const updated: HandRecord = {
      ...hand,
      status,
      updatedAt: new Date().toISOString(),
      metadata: { ...hand.metadata, ...metadataPatch },
    };
    this.hands.set(handId, updated);
    return updated;
  }

  async get(handId: string): Promise<HandRecord | null> {
    return this.hands.get(handId) ?? null;
  }

  async listBySession(sessionId: string): Promise<HandRecord[]> {
    return [...this.hands.values()].filter((h) => h.sessionId === sessionId);
  }

  async listByWorkspace(workspaceId: string): Promise<HandRecord[]> {
    return [...this.hands.values()].filter((h) => h.workspaceId === workspaceId);
  }

  async listByType(type: ExecutionTargetKind, opts?: { status?: HandStatus }): Promise<HandRecord[]> {
    return [...this.hands.values()].filter((h) =>
      h.type === type && (!opts?.status || h.status === opts.status),
    );
  }
}

class InMemoryEventStore implements EventStore {
  readonly events: PlatformEvent[] = [];

  async append(event: PlatformEventInput): Promise<PlatformEvent> {
    const stamped: PlatformEvent = {
      ...event,
      id: `e-${this.events.length}`,
      timestamp: new Date().toISOString(),
    } as PlatformEvent;
    this.events.push(stamped);
    return stamped;
  }

  async list(sessionId: string): Promise<PlatformEvent[]> {
    return this.events.filter((e) => 'sessionId' in e && e.sessionId === sessionId);
  }
}

describe('HandHealthScanner (B4)', () => {
  it('keeps ready hands ready when /health returns {status:"ok"}', async () => {
    const handStore = new InMemoryHandStore();
    const eventStore = new InMemoryEventStore();
    await handStore.register({ handId: 'h-1', sessionId: 's-1', workspaceId: 'w-1', type: 'server-remote', status: 'ready', endpoint: 'http://h.example' });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, eventStore, fetchImpl });
    const result = await scanner.scanOnce();
    expect(result.scanned).toBe(1);
    expect(result.flipped).toBe(0);
    expect(handStore.hands.get('h-1')?.status).toBe('ready');
    expect(eventStore.events).toEqual([]);
  });

  it('flips ready → unhealthy when /health returns HTTP error', async () => {
    const handStore = new InMemoryHandStore();
    const eventStore = new InMemoryEventStore();
    await handStore.register({ handId: 'h-2', sessionId: 's-1', workspaceId: 'w-1', type: 'server-remote', status: 'ready', endpoint: 'http://h.example' });
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 })) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, eventStore, fetchImpl });
    const result = await scanner.scanOnce();
    expect(result.flipped).toBe(1);
    expect(handStore.hands.get('h-2')?.status).toBe('unhealthy');
    expect(eventStore.events).toHaveLength(1);
    expect(eventStore.events[0]).toMatchObject({
      type: 'hand_health_changed',
      handId: 'h-2',
      status: 'unhealthy',
      detail: 'health_probe_failed',
    });
  });

  it('flips unhealthy → ready when /health recovers and writes recovered event', async () => {
    const handStore = new InMemoryHandStore();
    const eventStore = new InMemoryEventStore();
    await handStore.register({ handId: 'h-3', sessionId: 's-1', workspaceId: 'w-1', type: 'server-remote', status: 'unhealthy', endpoint: 'http://h.example' });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, eventStore, fetchImpl });
    const result = await scanner.scanOnce();
    expect(result.flipped).toBe(1);
    expect(handStore.hands.get('h-3')?.status).toBe('ready');
    expect(eventStore.events).toHaveLength(1);
    expect(eventStore.events[0]).toMatchObject({
      type: 'hand_health_changed',
      handId: 'h-3',
      status: 'ready',
      detail: 'health_probe_recovered',
    });
  });

  it('flips to unhealthy when the fetch throws (network drop)', async () => {
    const handStore = new InMemoryHandStore();
    await handStore.register({ handId: 'h-4', sessionId: 's-1', workspaceId: 'w-1', type: 'server-remote', status: 'ready', endpoint: 'http://h.example' });
    const fetchImpl = vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });
    const result = await scanner.scanOnce();
    expect(result.flipped).toBe(1);
    expect(handStore.hands.get('h-4')?.status).toBe('unhealthy');
  });

  it('sends bearer authorization when a per-hand token is resolved', async () => {
    const handStore = new InMemoryHandStore();
    await handStore.register({ handId: 'h-tenant', sessionId: 's-1', workspaceId: 'w-1', type: 'server-remote', status: 'ready', endpoint: 'http://tenant.example', metadata: { tenantRemoteHandId: 'tenant-A' } });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({
      unhealthyConfirmDelayMs: 1,
      handStore,
      fetchImpl,
      resolveHandAuthToken: async (h) => h.handId === 'h-tenant' ? 'tenant-bearer-xyz' : undefined,
      defaultServerRemoteAuthToken: 'default-fallback',
    });
    await scanner.scanOnce();
    const [, init] = (fetchImpl as unknown as { mock: { calls: Array<[any, RequestInit]> } }).mock.calls[0]!;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tenant-bearer-xyz');
  });

  it('falls back to defaultServerRemoteAuthToken when no per-hand token is available', async () => {
    const handStore = new InMemoryHandStore();
    await handStore.register({ handId: 'h-plain', sessionId: 's-1', workspaceId: 'w-1', type: 'server-remote', status: 'ready', endpoint: 'http://plain.example' });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({
      unhealthyConfirmDelayMs: 1,
      handStore,
      fetchImpl,
      defaultServerRemoteAuthToken: 'fallback-bearer',
    });
    await scanner.scanOnce();
    const [, init] = (fetchImpl as unknown as { mock: { calls: Array<[any, RequestInit]> } }).mock.calls[0]!;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer fallback-bearer');
  });

  it('skips hands without endpoint without flipping status', async () => {
    const handStore = new InMemoryHandStore();
    await handStore.register({ handId: 'h-noendpoint', sessionId: 's-1', workspaceId: 'w-1', type: 'server-remote', status: 'ready' });
    const fetchImpl = vi.fn(async () => new Response('should-not-be-called', { status: 200 })) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });
    const result = await scanner.scanOnce();
    expect(result.scanned).toBe(1);
    expect(result.flipped).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not probe non-server-remote hand types', async () => {
    const handStore = new InMemoryHandStore();
    await handStore.register({ handId: 'h-client', sessionId: 's-1', workspaceId: 'w-1', type: 'client', status: 'ready', endpoint: 'ws://client.example' });
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 200 })) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });
    const result = await scanner.scanOnce();
    expect(result.scanned).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });



  it('replays cached recipe for an unhealthy hand when health stays down', async () => {
    const handStore = new InMemoryHandStore();
    const eventStore = new InMemoryEventStore();
    await handStore.register({
      handId: 'h-reprovision',
      sessionId: 's-1',
      workspaceId: 'w-r',
      type: 'server-remote',
      status: 'unhealthy',
      endpoint: 'http://hand.example',
      metadata: { recipe: { workspaceId: 'w-r', setupCommands: ['true'] } },
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/health')) return new Response('down', { status: 503 });
      if (href.endsWith('/provision')) return new Response(JSON.stringify({ status: 'ok', metadata: { recipeHash: 'abc' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error(`unexpected url ${href}`);
    }) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, eventStore, fetchImpl, defaultServerRemoteAuthToken: 'token-1' });

    const result = await scanner.scanOnce();

    expect(result.flipped).toBe(1);
    expect(handStore.hands.get('h-reprovision')?.status).toBe('ready');
    expect(handStore.hands.get('h-reprovision')?.metadata.provision).toMatchObject({ attempts: 0, lastStatus: 'ok', recipeHash: 'abc' });
    const [, provisionInit] = (fetchImpl as unknown as { mock: { calls: Array<[any, RequestInit]> } }).mock.calls[1]!;
    expect(provisionInit.method).toBe('POST');
    expect(JSON.parse(String(provisionInit.body))).toMatchObject({ workspaceId: 'w-r', recipe: { workspaceId: 'w-r', setupCommands: ['true'] } });
  });

  it('backs off cached recipe reprovision failures instead of hammering the hand', async () => {
    const handStore = new InMemoryHandStore();
    await handStore.register({
      handId: 'h-retry',
      sessionId: 's-1',
      workspaceId: 'w-retry',
      type: 'server-remote',
      status: 'unhealthy',
      endpoint: 'http://hand.example',
      metadata: { recipe: { workspaceId: 'w-retry' }, provision: { retryPolicy: { maxAttempts: 2, backoffMs: [10_000] } } },
    });
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/health')) return new Response('down', { status: 503 });
      return new Response(JSON.stringify({ status: 'error', error: 'hydrate failed', metadata: { retryPolicy: { maxAttempts: 2, backoffMs: [10_000] } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });

    const result = await scanner.scanOnce();

    expect(result.flipped).toBe(0);
    expect(handStore.hands.get('h-retry')?.status).toBe('unhealthy');
    expect(handStore.hands.get('h-retry')?.metadata.provision).toMatchObject({ attempts: 1, lastStatus: 'error', lastError: 'hydrate failed', retryPolicy: { maxAttempts: 2, backoffMs: [10_000] } });
    expect(typeof (handStore.hands.get('h-retry')?.metadata.provision as any).nextAttemptAt).toBe('string');
  });

  it('logs a warning and no-ops when HandStore lacks listByType', async () => {
    const partialStore: HandStore = {
      async register() { throw new Error('unused'); },
      async updateStatus() { return null; },
      async get() { return null; },
      async listBySession() { return []; },
      async listByWorkspace() { return []; },
    };
    const warn = vi.fn();
    const scanner = new HandHealthScanner({
      handStore: partialStore,
      logger: { info: () => undefined, warn, error: () => undefined },
    });
    const result = await scanner.scanOnce();
    expect(result).toEqual({ scanned: 0, flipped: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
