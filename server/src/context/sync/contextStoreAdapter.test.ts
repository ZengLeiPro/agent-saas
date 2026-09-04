import { describe, expect, it, vi } from 'vitest';

import type { ContextSyncPartition } from '../store/index.js';
import { computeContextVersionFingerprint } from '../store/validation.js';
import {
  ContextStoreSyncAdapter,
  defaultPartitionIdentity,
  type ContextPartitionStore,
} from './contextStoreAdapter.js';
import type { ContextIngestPage, ContextSyncKey } from './types.js';

const key: ContextSyncKey = {
  tenantId: 'tenant-a',
  accountId: 'account-a',
  profileId: 'profile-a',
  source: 'chat',
};
const window = { from: '2026-08-22T00:00:00.000Z', to: '2026-08-22T01:00:00.000Z' };
const identity = { sourceId: 'dws-source', collectionId: 'chat', partitionKey: 'all-chat' };

function partition(overrides: Partial<ContextSyncPartition> = {}): ContextSyncPartition {
  return {
    tenantId: key.tenantId,
    ...identity,
    status: 'idle',
    leaseFence: 0,
    retryCount: 0,
    truncated: false,
    refused: false,
    updatedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function setup(partitionOverrides: Partial<ContextSyncPartition> = {}) {
  const current = partition({
    watermark: '2026-08-21T23:00:00.000Z',
    ...partitionOverrides,
  });
  const acquired = partition({
    ...current,
    status: 'syncing',
    leaseOwner: 'worker-a',
    leaseFence: 7,
  });
  const store: ContextPartitionStore = {
    ensurePartition: vi.fn().mockResolvedValue(current),
    getPartition: vi.fn().mockResolvedValue(current),
    listCurrentExternalRecordIds: vi.fn().mockResolvedValue([]),
    acquirePartitionLease: vi.fn().mockResolvedValue(acquired),
    renewPartitionLease: vi.fn().mockResolvedValue(true),
    ingestPage: vi.fn().mockResolvedValue({}),
    failPartition: vi.fn().mockResolvedValue(partition({
      status: 'retry_wait',
      retryCount: 2,
      nextRetryAt: '2026-08-22T01:01:00.000Z',
      windowStart: window.from,
      windowEnd: window.to,
      lastErrorCode: 'CONTEXT_SYNC_FAILED',
    })),
  };
  const adapter = new ContextStoreSyncAdapter({
    store,
    leaseOwner: 'worker-a',
    leaseMs: 60_000,
    retryBaseMs: 60_000,
    resolvePartition: () => identity,
  });
  return { adapter, store };
}

function page(overrides: Partial<ContextIngestPage> = {}): ContextIngestPage {
  return {
    key,
    window,
    nextCursor: 'cursor-2',
    truncated: false,
    items: [{
      idempotencyKey: 'dws:tenant-a:account-a:profile-a:chat:message-a',
      source: 'chat',
      sourceId: 'message-a',
      kind: 'chat_message',
      content: 'hello',
      conversationId: 'conversation-a',
      occurredAt: '2026-08-22T00:30:00.000Z',
      metadata: { senderId: 'user-a' },
      truncation: { truncated: false },
    }],
    ...overrides,
  };
}

describe('ContextStoreSyncAdapter', () => {
  it('maps pages through one fenced partition and commits watermark only at whole-window completion', async () => {
    const { adapter, store } = setup();

    await expect(adapter.getWatermark(key)).resolves.toBe('2026-08-21T23:00:00.000Z');
    await adapter.ingestPage(page());
    await adapter.ingestPage(page({ cursor: 'cursor-2', nextCursor: undefined, truncated: true }));

    const pageCalls = vi.mocked(store.ingestPage).mock.calls.map(call => call[0]);
    expect(pageCalls).toHaveLength(1);
    expect(pageCalls.every(call => call.checkpoint.watermark === undefined)).toBe(true);
    expect(pageCalls[0]).toMatchObject({
      tenantId: 'tenant-a',
      ...identity,
      leaseOwner: 'worker-a',
      leaseFence: 7,
      checkpoint: {
        windowStart: window.from,
        windowEnd: window.to,
        pageCursor: 'cursor-2',
        complete: false,
      },
    });
    expect(pageCalls[0]!.records[0]).toMatchObject({
      externalRecordId: 'dws:tenant-a:account-a:profile-a:chat:message-a',
      content: { text: 'hello', kind: 'chat_message' },
      metadata: { source: 'chat', conversationId: 'conversation-a' },
    });
    expect(pageCalls[0]!.records[0]!.recordId).toMatch(/^dws-[0-9a-f]{48}$/);
    expect(pageCalls[0]!.records[0]!.evidence).toEqual([{
      evidenceId: expect.stringMatching(/^source-locator-[0-9a-f]{40}$/),
      kind: 'source_locator',
      data: {
        externalId: 'message-a',
        excerpt: 'hello',
        source: 'chat',
        occurredAt: '2026-08-22T00:30:00.000Z',
        conversationId: 'conversation-a',
        author: 'user-a',
      },
    }]);

    await adapter.advanceWatermark({
      key,
      expected: '2026-08-21T23:00:00.000Z',
      value: window.to,
    });

    expect(store.acquirePartitionLease).toHaveBeenCalledTimes(1);
    expect(store.ingestPage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(store.ingestPage).mock.calls[1]![0]).toMatchObject({
      records: [expect.objectContaining({ externalRecordId: 'dws:tenant-a:account-a:profile-a:chat:message-a' })],
      checkpoint: {
        watermark: window.to,
        complete: true,
        truncated: true,
        coverageStart: window.from,
        coverageEnd: window.to,
      },
    });
  });

  it('uses account-scoped opaque collection identities so same-tenant DWS accounts cannot collide', () => {
    const first = defaultPartitionIdentity(key);
    const second = defaultPartitionIdentity({ ...key, accountId: 'account-b' });
    const repeated = defaultPartitionIdentity(key);

    expect(first.collectionId).toBe(repeated.collectionId);
    expect(first.collectionId).toMatch(/^dws-chat-[0-9a-f]{32}$/);
    expect(second.collectionId).not.toBe(first.collectionId);
    expect(first.collectionId).not.toContain(key.tenantId);
    expect(first.collectionId).not.toContain(key.accountId);
    expect(first.collectionId).not.toContain(key.profileId);
  });

  it('materializes trusted group ownership into the ingested revision and prevents upstream metadata from spoofing it', async () => {
    const { store } = setup();
    const resolveRecordMetadata = vi.fn(async () => ({
      agentId: 'agent-group-a',
      bindingId: 'binding-group-a',
      conversationSpaceId: 'space-group-a',
      workConversationId: 'work-group-a',
      policyRevision: 9,
      visibility: 'conversation',
      orgAgentContextScope: 'work_conversation',
    }));
    const adapter = new ContextStoreSyncAdapter({
      store,
      leaseOwner: 'worker-a',
      leaseMs: 60_000,
      retryBaseMs: 60_000,
      resolvePartition: () => identity,
      resolveRecordMetadata,
    });
    const forged = page({
      nextCursor: undefined,
      items: [{
        ...page().items[0]!,
        metadata: {
          senderId: 'user-a',
          agentId: 'forged-agent',
          bindingId: 'forged-binding',
          conversationSpaceId: 'forged-space',
          workConversationId: 'forged-work',
          policyRevision: 1,
          visibility: 'public',
        },
      }],
    });

    await adapter.ingestPage(forged);
    await adapter.advanceWatermark({
      key,
      expected: '2026-08-21T23:00:00.000Z',
      value: window.to,
    });

    const record = vi.mocked(store.ingestPage).mock.calls[0]![0].records[0]!;
    expect(resolveRecordMetadata).toHaveBeenCalledWith(key, forged.items[0]);
    expect(record.metadata).toMatchObject({
      agentId: 'agent-group-a',
      bindingId: 'binding-group-a',
      conversationSpaceId: 'space-group-a',
      workConversationId: 'work-group-a',
      policyRevision: 9,
      visibility: 'conversation',
      orgAgentContextScope: 'work_conversation',
    });
    expect(computeContextVersionFingerprint(record)).not.toBe(
      computeContextVersionFingerprint({
        ...record,
        metadata: { ...record.metadata, bindingId: 'other-binding' },
      }),
    );
  });

  it('renews an active lease during long-running upstream inventory work', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-22T00:00:00.000Z'));
      const { adapter, store } = setup();
      await adapter.getWatermark(key);
      vi.setSystemTime(new Date('2026-08-22T00:00:21.000Z'));

      await adapter.heartbeat();

      expect(store.renewPartitionLease).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never reacquires a partition after a policy reset invalidates its fence', async () => {
    const { adapter, store } = setup();
    await adapter.getWatermark(key);
    vi.mocked(store.renewPartitionLease).mockResolvedValue(false);

    await expect(adapter.ingestPage(page())).rejects.toThrow(/invalidated/);
    await expect(adapter.recordRetryFailure({
      key,
      window,
      error: 'stale worker',
      failedAt: window.to,
    })).rejects.toThrow(/invalidated/);
    expect(store.acquirePartitionLease).toHaveBeenCalledTimes(1);
    expect(store.ingestPage).not.toHaveBeenCalled();
  });

  it('returns a resume cursor only for the exact durable failed window', async () => {
    const { adapter } = setup({
      status: 'retry_wait',
      windowStart: window.from,
      windowEnd: window.to,
      pageCursor: 'cursor-2',
    });

    await expect(adapter.getResumeCursor(key, window)).resolves.toBe('cursor-2');
    await expect(adapter.getResumeCursor(key, { ...window, to: '2026-08-22T02:00:00.000Z' }))
      .resolves.toBeUndefined();
    await expect(adapter.getResumeCursor({ ...key, source: 'wiki' }, window))
      .resolves.toBeUndefined();
  });

  it('bounds source-locator evidence excerpts while preserving optional locators', async () => {
    const { adapter, store } = setup();
    await adapter.ingestPage(page({
      nextCursor: undefined,
      items: [{
        ...page().items[0]!,
        content: '😀'.repeat(600),
        url: 'https://example.test/message-a',
      }],
    }));
    await adapter.advanceWatermark({
      key,
      expected: '2026-08-21T23:00:00.000Z',
      value: window.to,
    });

    const record = vi.mocked(store.ingestPage).mock.calls[0]![0].records[0]!;
    expect(Array.from(String(record.evidence![0]!.data.excerpt))).toHaveLength(500);
    expect(record.evidence![0]!.data).toMatchObject({
      externalId: 'message-a',
      conversationId: 'conversation-a',
      url: 'https://example.test/message-a',
      author: 'user-a',
    });
  });

  it('revokes records absent from a complete inventory and keeps present records active', async () => {
    const { adapter, store } = setup();
    vi.mocked(store.listCurrentExternalRecordIds).mockResolvedValue([
      'dws:tenant-a:account-a:profile-a:wiki:doc-present',
      'dws:tenant-a:account-a:profile-a:wiki:doc-revoked',
    ]);
    const wikiKey = { ...key, source: 'wiki' as const };

    await expect(adapter.reconcileInventory({
      key: wikiKey,
      window,
      externalRecordIds: ['dws:tenant-a:account-a:profile-a:wiki:doc-present'],
    })).resolves.toBe(1);
    await adapter.advanceWatermark({
      key: wikiKey,
      expected: '2026-08-21T23:00:00.000Z',
      value: window.to,
    });

    expect(store.ingestPage).toHaveBeenCalledWith(expect.objectContaining({
      records: [expect.objectContaining({
        externalRecordId: 'dws:tenant-a:account-a:profile-a:wiki:doc-revoked',
        revoked: true,
        content: null,
        metadata: { source: 'wiki', revocationReason: 'inventory_absent' },
      })],
      checkpoint: expect.objectContaining({ complete: true, watermark: window.to }),
    }));
  });

  it('commits large inventory revocations with the terminal watermark transaction', async () => {
    const { adapter, store } = setup();
    vi.mocked(store.listCurrentExternalRecordIds).mockResolvedValue(
      Array.from({ length: 1_001 }, (_, index) => `wiki-record-${index}`),
    );

    await expect(adapter.reconcileInventory({
      key: { ...key, source: 'wiki' },
      window,
      externalRecordIds: [],
    })).resolves.toBe(1_001);
    await adapter.advanceWatermark({
      key: { ...key, source: 'wiki' },
      expected: '2026-08-21T23:00:00.000Z',
      value: window.to,
    });

    expect(vi.mocked(store.ingestPage).mock.calls.map(call => call[0].records.length))
      .toEqual([1_001]);
  });

  it('persists the exact failed window then maps failure to failPartition without advancing watermark', async () => {
    const { adapter, store } = setup();

    await adapter.getWatermark(key);
    const retry = await adapter.recordRetryFailure({
      key,
      window,
      error: 'authorization=Bearer-secret access_token=raw-token',
      failedAt: '2026-08-22T01:00:00.000Z',
    });

    expect(store.ingestPage).toHaveBeenCalledWith(expect.objectContaining({
      records: [],
      checkpoint: expect.objectContaining({
        windowStart: window.from,
        windowEnd: window.to,
        complete: false,
      }),
    }));
    expect(store.failPartition).toHaveBeenCalledWith(expect.objectContaining({
      ...identity,
      leaseFence: 7,
      errorCode: 'CONTEXT_SYNC_FAILED',
      retryAt: '2026-08-22T01:01:00.000Z',
    }));
    expect(retry).toMatchObject({ attempt: 2, window, nextAttemptAt: '2026-08-22T01:01:00.000Z' });
    expect(retry.lastError).not.toContain('raw-token');
    expect(vi.mocked(store.ingestPage).mock.calls.some(call => call[0].checkpoint.watermark !== undefined)).toBe(false);
  });

  it('persists unreadable upstream pages as an explicit operational outcome', async () => {
    const { adapter, store } = setup();
    await adapter.getWatermark(key);
    await adapter.recordRetryFailure({
      key,
      window,
      error: 'DWS chat returned truncated upstream content',
      failedAt: '2026-08-22T01:00:00.000Z',
    });
    expect(store.failPartition).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'CONTEXT_SYNC_UNREADABLE',
    }));
  });

  it('marks deterministic upstream authorization failures refused instead of retrying forever', async () => {
    const { adapter, store } = setup();
    await adapter.getWatermark(key);
    await adapter.recordRetryFailure({
      key,
      window,
      error: 'DWS command failed: 403 forbidden',
      failedAt: '2026-08-22T01:00:00.000Z',
    });
    expect(store.failPartition).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: 'CONTEXT_SYNC_REFUSED',
      refused: true,
    }));
  });

  it('reconstructs durable retry state from the ContextStore partition', async () => {
    const { adapter } = setup({
      status: 'retry_wait',
      retryCount: 3,
      nextRetryAt: '2026-08-22T02:00:00.000Z',
      windowStart: window.from,
      windowEnd: window.to,
      lastErrorCode: 'CONTEXT_SYNC_FAILED',
    });

    await expect(adapter.getRetryState(key)).resolves.toEqual({
      key,
      window,
      attempt: 3,
      status: 'waiting',
      nextAttemptAt: '2026-08-22T02:00:00.000Z',
      lastError: 'CONTEXT_SYNC_FAILED',
    });
  });

  it('rejects stale expected watermarks before the complete checkpoint', async () => {
    const { adapter, store } = setup();
    await adapter.ingestPage(page({ nextCursor: undefined }));

    await expect(adapter.advanceWatermark({ key, expected: null, value: window.to }))
      .rejects.toThrow(/compare-and-set/);
    expect(vi.mocked(store.ingestPage).mock.calls).toHaveLength(0);
  });
});
