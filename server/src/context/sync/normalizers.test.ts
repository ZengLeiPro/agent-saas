import { describe, expect, it } from 'vitest';

import {
  CONTEXT_TRUNCATION_MARKER,
  createIngestPage,
  normalizeChatMessage,
  normalizeMinutes,
  normalizeWikiDocument,
} from './normalizers.js';

const context = {
  key: {
    tenantId: 'tenant-a', accountId: 'account-a', profileId: 'profile-a', source: 'chat' as const,
  },
  window: { from: '2026-08-22T00:00:00.000Z', to: '2026-08-22T01:00:00.000Z' },
  maxContentCharacters: 40,
};

describe('DWS context normalizers', () => {
  it('marks local chat clipping on both the item and unified ingest page', () => {
    const item = normalizeChatMessage(context, {
      messageId: 'message-a',
      conversationId: 'conversation-a',
      text: 'x'.repeat(100),
      createdAt: '2026-08-22T00:30:00.000Z',
    });
    const page = createIngestPage({ context, items: [item] });

    expect(Array.from(item.content)).toHaveLength(40);
    expect(item.content).toContain(CONTEXT_TRUNCATION_MARKER);
    expect(item.truncation).toEqual({
      truncated: true,
      reason: 'content_limit',
      limitCharacters: 40,
      originalCharacters: 100,
    });
    expect(page.truncated).toBe(true);
  });

  it('normalizes a wiki document body and keeps upstream truncation explicit', () => {
    const wikiContext = { ...context, key: { ...context.key, source: 'wiki' as const } };
    const item = normalizeWikiDocument(wikiContext, {
      documentId: 'doc-a',
      title: '方案',
      updatedAt: '2026-08-22T00:20:00.000Z',
      spaceId: 'space-a',
    }, {
      content: 'partial body',
      format: 'markdown',
      truncated: true,
    });

    expect(item).toMatchObject({
      source: 'wiki',
      kind: 'wiki_document',
      title: '方案',
      content: 'partial body',
      metadata: { spaceId: 'space-a', format: 'markdown' },
      truncation: { truncated: true, reason: 'upstream' },
    });
  });

  it('preserves upstream as the authoritative truncation reason when local clipping also applies', () => {
    const item = normalizeChatMessage(context, {
      messageId: 'message-upstream-partial',
      conversationId: 'conversation-a',
      text: 'x'.repeat(100),
      createdAt: '2026-08-22T00:30:00.000Z',
      truncated: true,
    });

    expect(item.truncation).toEqual({
      truncated: true,
      reason: 'upstream',
      limitCharacters: 40,
      originalCharacters: 100,
    });
  });

  it('normalizes minutes summary and transcript into one ingest item', () => {
    const minutesContext = {
      ...context,
      key: { ...context.key, source: 'minutes' as const },
      maxContentCharacters: 1_000,
    };
    const item = normalizeMinutes(minutesContext, {
      minutesId: 'minutes-a',
      title: '周会',
      startedAt: '2026-08-22T00:10:00.000Z',
      durationSeconds: 600,
    }, { content: '结论' }, { content: '完整发言' });

    expect(item).toMatchObject({
      source: 'minutes',
      kind: 'minutes',
      title: '周会',
      content: '摘要\n结论\n\n转写\n完整发言',
      metadata: { hasSummary: true, hasTranscript: true, durationSeconds: 600 },
      truncation: { truncated: false },
    });
  });
});
