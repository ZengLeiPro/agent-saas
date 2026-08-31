import { describe, expect, it, vi } from 'vitest';

import type { ContextSyncStore, DwsContextClient } from './ports.js';
import { DwsContextSyncService } from './service.js';
import type { ContextIngestPage, ContextSyncKey, ContextSyncRetryState } from './types.js';

const scope = { tenantId: 'tenant-a', accountId: 'account-a', profileId: 'profile-a' };
const from = '2026-08-22T00:00:00.000Z';
const to = '2026-08-22T01:00:00.000Z';

function chatMessage(messageId: string, text = `message-${messageId}`) {
  return {
    messageId,
    conversationId: 'conversation-a',
    text,
    createdAt: '2026-08-22T00:30:00.000Z',
  };
}

function setup(options: { maxContentCharacters?: number } = {}) {
  const pages: ContextIngestPage[] = [];
  const retryState: ContextSyncRetryState = {
    key: { ...scope, source: 'chat' },
    window: { from, to },
    attempt: 1,
    status: 'waiting',
    nextAttemptAt: '2026-08-22T01:01:00.000Z',
    lastError: 'failed',
  };
  const store: ContextSyncStore = {
    getWatermark: vi.fn().mockResolvedValue(null),
    getResumeCursor: vi.fn().mockResolvedValue(undefined),
    ingestPage: vi.fn(async page => { pages.push(page); }),
    reconcileInventory: vi.fn().mockResolvedValue(0),
    advanceWatermark: vi.fn().mockResolvedValue(undefined),
    getRetryState: vi.fn().mockResolvedValue(null),
    recordRetryFailure: vi.fn().mockResolvedValue(retryState),
    clearRetryState: vi.fn().mockResolvedValue(undefined),
  };
  const client: DwsContextClient = {
    listChatMessages: vi.fn().mockResolvedValue({ items: [] }),
    listWikiDocuments: vi.fn().mockResolvedValue({ items: [] }),
    getWikiDocumentBody: vi.fn().mockResolvedValue({ content: '' }),
    listMinutes: vi.fn().mockResolvedValue({ items: [] }),
    getMinutesSummary: vi.fn().mockResolvedValue({ content: '' }),
    getMinutesTranscript: vi.fn().mockResolvedValue({ content: '' }),
  };
  const service = new DwsContextSyncService({
    store,
    client,
    clock: () => new Date(to),
    defaultLookbackMs: 60 * 60 * 1_000,
    ...(options.maxContentCharacters !== undefined
      ? { maxContentCharacters: options.maxContentCharacters }
      : {}),
  });
  return { service, store, client, pages };
}

describe('DwsContextSyncService', () => {
  it('does not advance the watermark when a later page fails and persists retry state', async () => {
    const { service, store, client, pages } = setup();
    vi.mocked(client.listChatMessages)
      .mockResolvedValueOnce({ items: [chatMessage('m-1')], nextCursor: 'page-2' })
      .mockRejectedValueOnce(new Error('DWS page unavailable'));

    await expect(service.syncWindow({ scope, source: 'chat', from, to })).rejects.toThrow(
      'DWS page unavailable',
    );

    expect(pages).toHaveLength(1);
    expect(store.advanceWatermark).not.toHaveBeenCalled();
    expect(store.clearRetryState).not.toHaveBeenCalled();
    expect(store.recordRetryFailure).toHaveBeenCalledWith(expect.objectContaining({
      key: { ...scope, source: 'chat' },
      window: { from, to },
      error: 'DWS page unavailable',
    }));
  });

  it('lands an upstream-truncated page but fails the window without advancing its cursor or watermark', async () => {
    const { service, store, client, pages } = setup();
    vi.mocked(client.listChatMessages).mockResolvedValueOnce({
      items: [chatMessage('m-partial')],
      nextCursor: 'unsafe-next-page',
      truncated: true,
    });

    await expect(service.syncWindow({ scope, source: 'chat', from, to }))
      .rejects.toThrow('DWS chat returned truncated upstream content');

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ truncated: true });
    expect(pages[0]!.nextCursor).toBeUndefined();
    expect(store.advanceWatermark).not.toHaveBeenCalled();
    expect(store.recordRetryFailure).toHaveBeenCalledTimes(1);
  });

  it('lands an unproven minutes inventory but does not advance its watermark', async () => {
    const { service, store, client, pages } = setup();
    vi.mocked(client.listMinutes).mockResolvedValueOnce({
      items: [{ minutesId: 'minutes-partial', title: '未证明完整', startedAt: '2026-08-22T00:30:00.000Z' }],
      truncated: true,
    });
    vi.mocked(client.getMinutesSummary).mockResolvedValueOnce({ content: '部分摘要' });
    vi.mocked(client.getMinutesTranscript).mockResolvedValueOnce({ content: '部分转写' });

    await expect(service.syncWindow({ scope, source: 'minutes', from, to }))
      .rejects.toThrow('DWS minutes returned truncated upstream content');

    expect(pages[0]).toMatchObject({ truncated: true, items: [{ sourceId: 'minutes-partial' }] });
    expect(store.advanceWatermark).not.toHaveBeenCalled();
    expect(store.recordRetryFailure).toHaveBeenCalledTimes(1);
  });

  it('does not advance the minutes watermark when layered pagination declarations conflict', async () => {
    const { service, store, client, pages } = setup();
    vi.mocked(client.listMinutes).mockResolvedValueOnce({
      items: [{ minutesId: 'minutes-conflict', title: '分页声明冲突', startedAt: '2026-08-22T00:30:00.000Z' }],
      truncated: true,
    });

    await expect(service.syncWindow({ scope, source: 'minutes', from, to }))
      .rejects.toThrow('DWS minutes returned truncated upstream content');

    expect(pages[0]).toMatchObject({ truncated: true, items: [{ sourceId: 'minutes-conflict' }] });
    expect(store.advanceWatermark).not.toHaveBeenCalled();
    expect(store.recordRetryFailure).toHaveBeenCalledTimes(1);
  });

  it('reconciles a complete wiki inventory before advancing its watermark', async () => {
    const { service, store, client } = setup();
    vi.mocked(client.listWikiDocuments)
      .mockResolvedValueOnce({
        items: [{ documentId: 'doc-a', title: 'A', updatedAt: '2026-08-22T00:10:00.000Z' }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        items: [{ documentId: 'doc-b', title: 'B', updatedAt: '2026-08-22T00:20:00.000Z' }],
      });
    vi.mocked(client.getWikiDocumentBody)
      .mockResolvedValueOnce({ content: 'A body' })
      .mockResolvedValueOnce({ content: 'B body' });

    await service.syncWindow({ scope, source: 'wiki', from, to });

    expect(store.reconcileInventory).toHaveBeenCalledWith({
      key: { ...scope, source: 'wiki' },
      window: { from, to },
      externalRecordIds: [
        'dws:tenant-a:account-a:profile-a:wiki:doc-a',
        'dws:tenant-a:account-a:profile-a:wiki:doc-b',
      ],
    });
    expect(store.reconcileInventory).toHaveBeenCalledBefore(vi.mocked(store.advanceWatermark));
  });

  it('revokes one Wiki document when its canonical body returns 403 without poisoning the inventory', async () => {
    const { service, store, client, pages } = setup();
    vi.mocked(client.listWikiDocuments).mockResolvedValueOnce({
      items: [{ documentId: 'doc-revoked', title: '已撤权', updatedAt: '2026-08-22T00:10:00.000Z' }],
    });
    vi.mocked(client.getWikiDocumentBody).mockRejectedValueOnce(new Error('403 forbidden'));

    await service.syncWindow({ scope, source: 'wiki', from, to });

    expect(pages[0]?.items[0]).toMatchObject({
      sourceId: 'doc-revoked',
      content: '',
      revoked: true,
      metadata: { unreadable: true, unreadableReason: 'document_revoked' },
    });
    expect(store.advanceWatermark).toHaveBeenCalledTimes(1);
    expect(store.recordRetryFailure).not.toHaveBeenCalled();
  });

  it('lands a wiki body flagged incomplete upstream but does not advance the watermark', async () => {
    const { service, store, client, pages } = setup();
    vi.mocked(client.listWikiDocuments).mockResolvedValueOnce({
      items: [{
        documentId: 'doc-partial', title: '未完整文档',
        updatedAt: '2026-08-22T00:30:00.000Z',
      }],
      nextCursor: 'unsafe-next-page',
    });
    vi.mocked(client.getWikiDocumentBody).mockResolvedValueOnce({
      content: 'partial body',
      truncated: true,
    });

    await expect(service.syncWindow({ scope, source: 'wiki', from, to }))
      .rejects.toThrow('DWS wiki returned truncated upstream content');

    expect(pages[0]).toMatchObject({
      truncated: true,
      items: [{ truncation: { truncated: true, reason: 'upstream' } }],
    });
    expect(pages[0]!.nextCursor).toBeUndefined();
    expect(store.advanceWatermark).not.toHaveBeenCalled();
    expect(store.recordRetryFailure).toHaveBeenCalledTimes(1);
  });

  it('can complete and advance when only an individual item is character-clipped', async () => {
    const { service, store, client, pages } = setup({ maxContentCharacters: 40 });
    vi.mocked(client.listChatMessages).mockResolvedValueOnce({
      items: [chatMessage('m-long', 'x'.repeat(100))],
    });

    await expect(service.syncWindow({ scope, source: 'chat', from, to })).resolves.toMatchObject({
      pages: 1,
      items: 1,
      truncated: true,
      watermarkAdvanced: true,
    });

    expect(pages[0]!.items[0]!.truncation.reason).toBe('content_limit');
    expect(store.advanceWatermark).toHaveBeenCalledTimes(1);
    expect(store.recordRetryFailure).not.toHaveBeenCalled();
  });

  it('offers stable idempotency keys to the store again on rerun instead of deduping in memory', async () => {
    const { service, store, client, pages } = setup();
    vi.mocked(client.listChatMessages)
      .mockResolvedValueOnce({ items: [chatMessage('m-1')], nextCursor: 'page-2' })
      .mockRejectedValueOnce(new Error('page-2 failed'))
      .mockResolvedValueOnce({ items: [chatMessage('m-1')], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ items: [chatMessage('m-2')] });

    await expect(service.syncWindow({ scope, source: 'chat', from, to })).rejects.toThrow();
    await expect(service.syncWindow({ scope, source: 'chat', from, to })).resolves.toMatchObject({
      pages: 2,
      items: 2,
      watermarkAdvanced: true,
    });

    expect(pages).toHaveLength(3);
    expect(pages[0]!.items[0]!.idempotencyKey).toBe(pages[1]!.items[0]!.idempotencyKey);
    expect(store.ingestPage).toHaveBeenCalledTimes(3);
    expect(store.advanceWatermark).toHaveBeenCalledTimes(1);
  });

  it('uses initialFrom only for a target without a watermark', async () => {
    const { service, store, client } = setup();
    const initialFrom = '2026-08-22T00:59:00.000Z';

    await service.syncWindow({ scope, source: 'chat', conversationId: 'conversation-a', initialFrom, to });
    expect(client.listChatMessages).toHaveBeenLastCalledWith(expect.objectContaining({
      window: { from: initialFrom, to },
      conversationId: 'conversation-a',
    }));

    vi.mocked(store.getWatermark).mockResolvedValueOnce('2026-08-22T00:45:00.000Z');
    await service.syncWindow({ scope, source: 'chat', conversationId: 'conversation-a', initialFrom, to });
    expect(client.listChatMessages).toHaveBeenLastCalledWith(expect.objectContaining({
      window: { from: '2026-08-22T00:45:00.000Z', to },
    }));
  });

  it('uses an event only to wake its conversation and fetches canonical message content', async () => {
    const { service, client, pages } = setup();
    vi.mocked(client.listChatMessages).mockResolvedValueOnce({
      items: [chatMessage('m-real', 'canonical body from DWS')],
    });

    const result = await service.handleEvent(scope, {
      type: 'user_im_message_receive_at',
      eventId: 'event-a',
      conversationId: 'conversation-a',
      content: 'untrusted notification body',
      raw: { content: 'also untrusted' },
    });

    expect(result.woken).toBe(true);
    expect(client.listChatMessages).toHaveBeenCalledWith(expect.objectContaining({
      scope,
      conversationId: 'conversation-a',
    }));
    expect(client.listWikiDocuments).not.toHaveBeenCalled();
    expect(client.listMinutes).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(client.listChatMessages).mock.calls)).not.toContain('untrusted');
    expect(pages[0]!.items[0]!.content).toBe('canonical body from DWS');
    expect(pages[0]!.key).toEqual({ ...scope, source: 'chat', conversationId: 'conversation-a' });
  });

  it('ignores unsupported or untargeted events without reading DWS', async () => {
    const { service, client } = setup();
    await expect(service.handleEvent(scope, {
      type: 'wiki_document_changed', eventId: 'e-1', conversationId: 'conversation-a',
    })).resolves.toEqual({ woken: false, reason: 'unsupported_event' });
    await expect(service.handleEvent(scope, {
      type: 'user_im_message_receive_at', eventId: 'e-2', content: 'body',
    })).resolves.toEqual({ woken: false, reason: 'missing_conversation' });
    expect(client.listChatMessages).not.toHaveBeenCalled();
  });

  it('replays the exact durable retry window', async () => {
    const { service, store, client } = setup();
    const key: ContextSyncKey = { ...scope, source: 'chat', conversationId: 'conversation-a' };
    vi.mocked(store.getRetryState).mockResolvedValueOnce({
      key,
      window: { from, to },
      attempt: 3,
      status: 'waiting',
      nextAttemptAt: to,
      lastError: 'temporary',
    });
    vi.mocked(store.getResumeCursor).mockResolvedValueOnce('page-3');
    vi.mocked(client.listChatMessages).mockResolvedValueOnce({ items: [] });

    await service.retry(key);

    expect(store.getResumeCursor).toHaveBeenCalledWith(key, { from, to });
    expect(client.listChatMessages).toHaveBeenCalledWith(expect.objectContaining({
      window: { from, to },
      conversationId: 'conversation-a',
      cursor: 'page-3',
    }));
  });
});
