import { describe, expect, it, vi } from 'vitest';

import { HandHealthScanner } from '../runtime/handHealthScanner.js';
import type { HandRecord, HandStore } from '../runtime/handStore.js';

function crashedTenantProvision(): HandRecord {
  return {
    handId: 'h-result-unknown', sessionId: 's-1', workspaceId: 'w-r', tenantId: 'tenant-1',
    type: 'server-remote', status: 'provisioning', endpoint: 'http://hand.example', capabilities: [],
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    metadata: {
      registeredBy: 'tenantRemoteHands', tenantRemoteHandId: 'tenant-ecs',
      recipe: { workspaceId: 'w-r', provisionKey: 'parked-key' },
      provisionKey: 'parked-key', provisionGeneration: 'parked-key',
      provision: { attempts: 0, lastStatus: 'provisioning' },
    },
  };
}

function fakeStore(initial: HandRecord): HandStore & { hand: HandRecord; claims: number; completions: number } {
  return {
    hand: initial, claims: 0, completions: 0,
    async register() { return this.hand; },
    async updateStatus(_handId, status, metadata = {}) {
      this.hand = { ...this.hand, status, metadata: { ...this.hand.metadata, ...metadata } };
      return this.hand;
    },
    async claimProvisionRecovery() { this.claims += 1; return null; },
    async completeProvisionAttempt(handId, generation, status, metadata = {}) {
      if (this.hand.handId !== handId || this.hand.status !== 'provisioning'
        || this.hand.metadata.provisionGeneration !== generation) return null;
      this.completions += 1;
      this.hand = { ...this.hand, status, metadata: { ...this.hand.metadata, ...metadata } };
      return this.hand;
    },
    async completeProvisionRecovery() { return null; },
    async get(handId) { return handId === this.hand.handId ? this.hand : null; },
    async listBySession(sessionId) { return this.hand.sessionId === sessionId ? [this.hand] : []; },
    async listByWorkspace(workspaceId) { return this.hand.workspaceId === workspaceId ? [this.hand] : []; },
    async listByType(type, options) {
      return this.hand.type === type && (!options?.status || this.hand.status === options.status) ? [this.hand] : [];
    },
  };
}

describe('HandHealthScanner tenant provision crash fence', () => {
  it('scanner-first recovery parks provisioning as result_unknown without health-ready or replay', async () => {
    const handStore = fakeStore(crashedTenantProvision());
    const fetchMock = vi.fn(async (_url: string | URL | Request) => new Response(JSON.stringify({ status: 'ok' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    const scanner = new HandHealthScanner({
      handStore, fetchImpl: fetchMock as unknown as typeof fetch, resolveHandAuthToken: () => 'token',
    });

    expect(await scanner.scanOnce()).toEqual({ scanned: 1, flipped: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(handStore.claims).toBe(0);
    expect(handStore.completions).toBe(1);
    expect(handStore.hand).toMatchObject({
      status: 'unhealthy',
      metadata: {
        provisionResult: 'result_unknown', reconcileRequired: true,
        provisionGeneration: 'parked-key',
        provision: { lastStatus: 'result_unknown' },
      },
    });

    expect(await scanner.scanOnce()).toEqual({ scanned: 1, flipped: 0 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/health');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/provision'))).toBe(false);
    expect(handStore.claims).toBe(0);
    expect(handStore.hand).toMatchObject({ status: 'unhealthy', metadata: { reconcileRequired: true } });
  });
});
