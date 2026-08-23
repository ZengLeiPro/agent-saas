import { describe, expect, it, vi } from 'vitest';

import { HandHealthScanner } from '../runtime/handHealthScanner.js';
import { PROVISION_RECOVERY_CLAIM_TTL_MS, type HandRecord, type HandStatus, type HandStore, type RegisterHandInput } from '../runtime/handStore.js';
import type { ExecutionTargetKind } from '../agent/toolRuntime.js';
import { RUNTIME_ISOLATION_POLICY_DIGEST } from '../runtime/runtimeIsolationEvidence.js';
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

  async claimProvisionRecovery(
    handId: string,
    recoveryToken: string,
    metadataPatch: Record<string, unknown> = {},
    expectedUpdatedAt?: string,
    expectedProvisionGeneration?: string,
  ): Promise<HandRecord | null> {
    const hand = this.hands.get(handId);
    if (!hand || !['ready', 'unhealthy'].includes(hand.status)) return null;
    if (expectedUpdatedAt && hand.updatedAt !== expectedUpdatedAt) return null;
    if (expectedProvisionGeneration && hand.metadata.provisionGeneration !== expectedProvisionGeneration) return null;
    const token = hand.metadata.provisionRecoveryToken;
    const claimedAt = hand.metadata.provisionRecoveryClaimedAtMs;
    if (typeof token === 'string' && typeof claimedAt === 'number'
      && claimedAt >= Date.now() - PROVISION_RECOVERY_CLAIM_TTL_MS) return null;
    return await this.updateStatus(handId, 'unhealthy', {
      ...metadataPatch,
      provisionRecoveryToken: recoveryToken,
      provisionRecoveryClaimedAtMs: Date.now(),
    });
  }

  async completeProvisionAttempt(
    handId: string,
    provisionGeneration: string,
    status: HandStatus,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<HandRecord | null> {
    const hand = this.hands.get(handId);
    if (hand?.status !== 'provisioning' || hand.metadata.provisionGeneration !== provisionGeneration) return null;
    return await this.updateStatus(handId, status, metadataPatch);
  }

  async completeProvisionRecovery(
    handId: string,
    recoveryToken: string,
    status: HandStatus,
    metadataPatch: Record<string, unknown> = {},
  ): Promise<HandRecord | null> {
    const hand = this.hands.get(handId);
    if (hand?.status !== 'unhealthy' || hand.metadata.provisionRecoveryToken !== recoveryToken) return null;
    return await this.updateStatus(handId, status, {
      ...metadataPatch,
      provisionRecoveryToken: null,
      provisionRecoveryClaimedAtMs: null,
    });
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

  it('keeps an unhealthy hand fail-closed when /health recovers but no session recipe exists', async () => {
    const handStore = new InMemoryHandStore();
    const eventStore = new InMemoryEventStore();
    await handStore.register({ handId: 'h-3', sessionId: 's-1', workspaceId: 'w-1', type: 'server-remote', status: 'unhealthy', endpoint: 'http://h.example' });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, eventStore, fetchImpl });
    const result = await scanner.scanOnce();
    expect(result.flipped).toBe(0);
    expect(handStore.hands.get('h-3')?.status).toBe('unhealthy');
    expect(eventStore.events).toHaveLength(0);
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

  it('marks unresolved provision failures unhealthy even when endpoint is missing', async () => {
    const handStore = new InMemoryHandStore();
    await handStore.register({
      handId: 'h-failed-noendpoint',
      sessionId: 's-1',
      workspaceId: 'w-1',
      type: 'server-remote',
      status: 'ready',
      metadata: { provisionFailure: 'missing endpoint after provision failure' },
    });
    const fetchImpl = vi.fn(async () => new Response('should-not-be-called', { status: 200 })) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });

    const result = await scanner.scanOnce();

    expect(result.flipped).toBe(1);
    expect(handStore.hands.get('h-failed-noendpoint')?.status).toBe('unhealthy');
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

  it('does not let global /health hide an unresolved session provision failure', async () => {
    const handStore = new InMemoryHandStore();
    handStore.hands.set('h-failed', makeHand({
      handId: 'h-failed',
      status: 'ready',
      metadata: {
        recipe: { workspaceId: 'workspace-1', sessionId: 'session-1' },
        provisionFailure: 'ACS SNAT managed entry quota exceeded: 28/28',
      },
    }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.endsWith('/provision')) {
        return new Response(JSON.stringify({ status: 'error', error: 'still outside shared CIDRs' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected url ${href}`);
    }) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });

    await scanner.scanOnce();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(handStore.hands.get('h-failed')?.status).toBe('unhealthy');
    expect(handStore.hands.get('h-failed')?.metadata.provisionFailure).toBe('still outside shared CIDRs');
  });

  it('clears provisionFailure only after session-specific reprovision succeeds', async () => {
    const handStore = new InMemoryHandStore();
    handStore.hands.set('h-recovered', makeHand({
      handId: 'h-recovered',
      status: 'unhealthy',
      metadata: {
        recipe: { workspaceId: 'workspace-1', sessionId: 'session-1' },
        provisionFailure: 'old failure',
      },
    }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (href.endsWith('/provision')) {
        return new Response(JSON.stringify({ status: 'ok', metadata: { recipeHash: 'recovered' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected url ${href}`);
    }) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });

    await scanner.scanOnce();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(handStore.hands.get('h-recovered')?.status).toBe('ready');
    expect(handStore.hands.get('h-recovered')?.metadata.provisionFailure).toBeNull();
  });

  it('requires fresh bound isolation evidence before recovering an attested hand', async () => {
    const requirement = {
      tenantId: 'tenant-1',
      taskId: 'task-1',
      runId: 'run-1',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
    };
    const handStore = new InMemoryHandStore();
    handStore.hands.set('h-attested', makeHand({
      handId: 'h-attested',
      runId: 'run-1',
      status: 'unhealthy',
      metadata: {
        recipe: {
          workspaceId: 'workspace-1',
          sessionId: 'session-1',
          sandboxScopeId: 'workspace-1',
          runtimeIsolationRequirement: requirement,
        },
        provisionFailure: 'old failure',
        runtimeIsolationAttested: true,
        runId: 'run-1',
        policyDigest: RUNTIME_ISOLATION_POLICY_DIGEST,
        sandboxName: 'as-old-sandbox',
        sandboxScopeId: 'workspace-1',
      },
    }));
    const now = Date.now();
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        status: 'ok',
        metadata: {
          runtimeIsolationEvidence: {
            ...requirement,
            sandboxName: 'as-new-sandbox',
            sandboxScopeId: 'wrong-scope',
            issuedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 30_000).toISOString(),
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });

    await scanner.scanOnce();

    expect(handStore.hands.get('h-attested')?.status).toBe('unhealthy');
    expect(String(handStore.hands.get('h-attested')?.metadata.provisionFailure))
      .toContain('RUNTIME_ISOLATION_EVIDENCE_BINDING_MISMATCH:sandboxScopeId');
    expect(handStore.hands.get('h-attested')?.metadata.sandboxName).toBe('as-old-sandbox');
  });

  it('does not let a stale health failure overwrite a newer provisioning attempt', async () => {
    const handStore = new InMemoryHandStore();
    handStore.hands.set('h-health-race', makeHand({ handId: 'h-health-race', status: 'ready' }));
    let probes = 0;
    const fetchImpl = vi.fn(async () => {
      probes += 1;
      if (probes === 1) {
        await handStore.updateStatus('h-health-race', 'provisioning', {
          provisionGeneration: 'new-generation',
          provisionFailure: null,
        });
      }
      return new Response(JSON.stringify({ status: 'error' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });

    await scanner.scanOnce();

    expect(handStore.hands.get('h-health-race')?.status).toBe('provisioning');
    expect(handStore.hands.get('h-health-race')?.metadata.provisionGeneration).toBe('new-generation');
  });

  it('does not duplicate reprovision while another scanner holds a fresh recovery claim', async () => {
    const handStore = new InMemoryHandStore();
    handStore.hands.set('h-claimed', makeHand({
      handId: 'h-claimed',
      status: 'unhealthy',
      metadata: {
        recipe: { workspaceId: 'workspace-1', sessionId: 'session-1' },
        provisionFailure: 'old failure',
        provisionRecoveryToken: 'other-scanner',
        provisionRecoveryClaimedAtMs: Date.now(),
      },
    }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });

    await scanner.scanOnce();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(handStore.hands.get('h-claimed')?.status).toBe('unhealthy');
    expect(handStore.hands.get('h-claimed')?.metadata.provisionRecoveryToken).toBe('other-scanner');
  });

  it('does not let a stale scanner reprovision failure overwrite a newer success', async () => {
    const handStore = new InMemoryHandStore();
    handStore.hands.set('h-race', makeHand({
      handId: 'h-race',
      status: 'unhealthy',
      metadata: {
        recipe: { workspaceId: 'workspace-1', sessionId: 'session-1' },
        provisionFailure: 'old failure',
      },
    }));
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      await handStore.updateStatus('h-race', 'ready', {
        provisionFailure: null,
        provisionRecoveryToken: null,
        provision: { attempts: 0, lastStatus: 'ok' },
      });
      return new Response(JSON.stringify({ status: 'error', error: 'stale failure' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });

    await scanner.scanOnce();

    expect(handStore.hands.get('h-race')?.status).toBe('ready');
    expect(handStore.hands.get('h-race')?.metadata.provisionFailure).toBeNull();
    expect((handStore.hands.get('h-race')?.metadata.provision as any).lastStatus).toBe('ok');
  });

  it('probes a shared endpoint once and fans the result out to all hands (2026-08-03 P0b)', async () => {
    const handStore = new InMemoryHandStore();
    // 生产形态：per-session hands 全部指向同一个 orchestrator endpoint。
    for (let i = 0; i < 50; i++) {
      handStore.hands.set(`h-${i}`, makeHand({ handId: `h-${i}`, status: i % 10 === 0 ? 'unhealthy' : 'ready' }));
    }
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({ unhealthyConfirmDelayMs: 1, handStore, fetchImpl });

    const result = await scanner.scanOnce();

    // 50 条 hand 只 probe 1 次（同 endpoint + 同 token 合并）
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
    expect(result.scanned).toBe(50);
    // /health 不能替代 session-specific /provision；缺 recipe 的 5 条保持 unhealthy。
    expect(result.flipped).toBe(0);
    expect([...handStore.hands.values()].filter((hand) => hand.status === 'unhealthy')).toHaveLength(5);
  });

  it('keeps distinct endpoints/tokens in separate probe groups (2026-08-03 P0b)', async () => {
    const handStore = new InMemoryHandStore();
    handStore.hands.set('h-a', makeHand({ handId: 'h-a', endpoint: 'http://hand-a.example' }));
    handStore.hands.set('h-b', makeHand({ handId: 'h-b', endpoint: 'http://hand-b.example' }));
    handStore.hands.set('h-a2', makeHand({
      handId: 'h-a2',
      endpoint: 'http://hand-a.example',
      metadata: { tenantRemoteHandId: 'tenant-1' },
    }));
    const probed: string[] = [];
    const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
      probed.push(`${String(url)} ${(init?.headers as Record<string, string> | undefined)?.authorization ?? ''}`);
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({
      unhealthyConfirmDelayMs: 1,
      handStore,
      fetchImpl,
      defaultServerRemoteAuthToken: 'default-token',
      resolveHandAuthToken: (hand) => (hand.metadata.tenantRemoteHandId ? 'tenant-token' : undefined),
    });

    await scanner.scanOnce();

    // endpoint-a(default token) / endpoint-b(default token) / endpoint-a(tenant token) = 3 组
    expect(probed).toHaveLength(3);
    expect(new Set(probed).size).toBe(3);
  });

  it('isolates auth token resolution failures to the affected hand', async () => {
    const handStore = new InMemoryHandStore();
    handStore.hands.set('h-missing-secret', makeHand({
      handId: 'h-missing-secret',
      endpoint: 'http://missing-secret.example',
      metadata: { tenantRemoteHandId: 'tenant-missing-secret' },
    }));
    handStore.hands.set('h-healthy', makeHand({
      handId: 'h-healthy',
      endpoint: 'http://healthy.example',
    }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const warn = vi.fn();
    const scanner = new HandHealthScanner({
      unhealthyConfirmDelayMs: 1,
      handStore,
      fetchImpl,
      defaultServerRemoteAuthToken: 'default-token',
      resolveHandAuthToken: async () => undefined,
      logger: { info: () => undefined, warn, error: () => undefined },
    });

    const result = await scanner.scanOnce();

    expect(result).toEqual({ scanned: 2, flipped: 0 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl as any).mock.calls[0]?.[0])).toContain('healthy.example/health');
    expect(handStore.hands.get('h-missing-secret')?.status).toBe('ready');
    expect(warn).toHaveBeenCalledWith(
      'HandHealthScanner: auth token unavailable for handId=h-missing-secret; skipping probe',
    );
  });

  it('contains unexpected scheduled scan failures instead of leaking an unhandled rejection', async () => {
    vi.useFakeTimers();
    try {
      const handStore = new InMemoryHandStore();
      handStore.listByType = vi.fn(async () => { throw new Error('store unavailable'); });
      const error = vi.fn();
      const scanner = new HandHealthScanner({
        intervalMs: 10,
        handStore,
        logger: { info: () => undefined, warn: () => undefined, error },
      });

      scanner.start();
      await vi.advanceTimersByTimeAsync(10);
      scanner.stop();

      expect(error).toHaveBeenCalledWith('HandHealthScanner scan failed: store unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a warning and no-ops when HandStore lacks listByType', async () => {
    const partialStore: HandStore = {
      async register() { throw new Error('unused'); },
      async updateStatus() { return null; },
      async claimProvisionRecovery() { return null; },
      async completeProvisionAttempt() { return null; },
      async completeProvisionRecovery() { return null; },
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
