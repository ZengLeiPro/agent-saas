import { describe, expect, it, vi } from 'vitest';

import { HandHealthScanner } from '../runtime/handHealthScanner.js';
import type { HandRecord, HandStore } from '../runtime/handStore.js';

const loopbackHand: HandRecord = {
  handId: 'h-loopback',
  tenantId: 'tenant-loopback',
  sessionId: 's-loopback',
  workspaceId: 'w-loopback',
  type: 'server-remote',
  status: 'ready',
  endpoint: 'http://127.0.0.1:3410',
  capabilities: [],
  createdAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z',
  metadata: {},
};

function handStore(hand: HandRecord = loopbackHand): HandStore {
  return {
    async register() {
      throw new Error('unused');
    },
    async updateStatus() {
      throw new Error('unexpected status change');
    },
    async claimProvisionRecovery() {
      throw new Error('unexpected recovery claim');
    },
    async completeProvisionAttempt() {
      throw new Error('unexpected provision completion');
    },
    async completeProvisionRecovery() {
      throw new Error('unexpected recovery completion');
    },
    async get() {
      return hand;
    },
    async listBySession() {
      return [hand];
    },
    async listByWorkspace() {
      return [hand];
    },
    async listByType(_type, options) {
      return options?.status === 'ready' ? [hand] : [];
    },
  };
}

describe('HandHealthScanner loopback routing', () => {
  it('bypasses the guarded global egress fetch only for a loopback Hand endpoint', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('proxy denied', { status: 403 }),
    ) as unknown as typeof fetch;
    const loopbackFetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({
      unhealthyConfirmDelayMs: 1,
      handStore: handStore(),
      fetchImpl,
      loopbackFetchImpl,
    });

    await expect(scanner.scanOnce()).resolves.toEqual({ scanned: 1, flipped: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(loopbackFetchImpl).toHaveBeenCalledOnce();
    expect(String((loopbackFetchImpl as any).mock.calls[0]?.[0])).toBe(
      'http://127.0.0.1:3410/health',
    );
  });

  it('keeps non-loopback Hand probes on the guarded fetch path', async () => {
    const externalHand = { ...loopbackHand, endpoint: 'https://hand.staging.internal' };
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;
    const loopbackFetchImpl = vi.fn(
      async () => new Response('unexpected', { status: 500 }),
    ) as unknown as typeof fetch;
    const scanner = new HandHealthScanner({
      unhealthyConfirmDelayMs: 1,
      handStore: handStore(externalHand),
      fetchImpl,
      loopbackFetchImpl,
    });

    await expect(scanner.scanOnce()).resolves.toEqual({ scanned: 1, flipped: 0 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(loopbackFetchImpl).not.toHaveBeenCalled();
  });
});
