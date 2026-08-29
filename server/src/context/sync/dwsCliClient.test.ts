import { describe, expect, it, vi } from 'vitest';

import { DwsCliContextClient, type DwsCliJsonExecutor } from './dwsCliClient.js';

const scope = { tenantId: 'tenant-a', accountId: 'account-a', profileId: 'corp:user' };
const window = { from: '2026-08-22T00:00:00.000Z', to: '2026-08-22T01:00:00.000Z' };

function setup(outputs: unknown[]) {
  const json = vi.fn();
  for (const output of outputs) json.mockResolvedValueOnce(output);
  const executor: DwsCliJsonExecutor = { json };
  const client = new DwsCliContextClient({ executor });
  return { client, json };
}

describe('DwsCliContextClient', () => {
  it('locks chat list-all argv, parses the v1.0.60 nested cursor envelope, and filters selected conversations', async () => {
    const { client, json } = setup([{
      result: {
        conversationMessagesList: [
          {
            openConversationId: 'conversation-a',
            messages: [{
              openMessageId: 'message-a', content: { text: 'hello' },
              createTime: 1_777_075_000_000, sender: { openDingTalkId: 'user-a' },
            }],
          },
          {
            openConversationId: 'conversation-b',
            messages: [{
              openMessageId: 'message-b', content: 'other', createTime: 1_777_075_100_000,
            }],
          },
        ],
        hasMore: true,
        nextCursor: 'cursor-2',
      },
    }]);

    const result = await client.listChatMessages({
      scope, window, pageSize: 50, conversationIds: ['conversation-a', 'conversation-c'],
    });

    expect(json).toHaveBeenCalledWith([
      'dws', 'chat', 'message', 'list-all',
      '--start', '2026-08-22 00:00:00',
      '--end', '2026-08-22 01:00:00',
      '--limit', '50',
      '--cursor', '0',
      '--profile', 'corp:user',
      '--format', 'json',
    ], {
      context: { ...scope, operation: 'chat.list' },
    });
    expect(result).toEqual({
      items: [{
        messageId: 'message-a',
        conversationId: 'conversation-a',
        text: 'hello',
        createdAt: '2026-04-24T23:56:40.000Z',
        senderId: 'user-a',
      }],
      nextCursor: 'cursor-2',
    });
  });

  it('marks an unreadable addressed chat item incomplete instead of silently advancing', async () => {
    const { client } = setup([{ items: [{ openConversationId: 'conversation-a', content: 'missing id/time' }] }]);
    await expect(client.listChatMessages({
      scope, window, pageSize: 20, conversationIds: ['conversation-a'],
    })).resolves.toEqual({ items: [], truncated: true });
  });

  it('passes a later chat cursor and marks an unpageable hasMore response truncated', async () => {
    const { client, json } = setup([{ items: [], hasMore: true }]);

    await expect(client.listChatMessages({
      scope, window, pageSize: 20, cursor: 'cursor-2',
    })).resolves.toEqual({ items: [], truncated: true });
    expect(json.mock.calls[0]![0]).toContain('cursor-2');
  });

  it('builds deletion-safe Wiki inventory from spaces and recursive nodes', async () => {
    const { client, json } = setup([
      { result: { wikiSpaces: [{ workspaceId: 'wiki-a' }], hasMore: false } },
      { data: { nodes: [{
        nodeId: 'doc-a', name: '方案', modifiedTime: '2026-08-22T00:30:00Z',
        createdTime: '2026-08-22T00:20:00Z', extension: 'adoc',
        docUrl: 'https://alidocs.dingtalk.com/i/nodes/doc-a',
      }] } },
      { data: { content: '# 方案', contentFormat: 'markdown', isTruncated: true } },
    ]);

    const documents = await client.listWikiDocuments({ scope, window, pageSize: 100 });
    const body = await client.getWikiDocumentBody({ scope, documentId: 'doc-a', extension: 'adoc' });

    expect(json.mock.calls[0]![0]).toEqual([
      'dws', 'wiki', 'space', 'list', '--profile', 'corp:user', '--format', 'json',
    ]);
    expect(json.mock.calls[1]![0]).toEqual([
      'dws', 'wiki', 'node', 'list', '--workspace', 'wiki-a',
      '--profile', 'corp:user', '--format', 'json',
    ]);
    expect(documents).toEqual({ items: [{
      documentId: 'doc-a', title: '方案', updatedAt: '2026-08-22T00:30:00.000Z',
      createdAt: '2026-08-22T00:20:00.000Z', extension: 'adoc', spaceId: 'wiki-a',
      url: 'https://alidocs.dingtalk.com/i/nodes/doc-a',
    }] });
    expect(json.mock.calls[2]![0]).toEqual([
      'dws', 'doc', 'read', '--node', 'doc-a', '--content-format', 'markdown',
      '--profile', 'corp:user', '--format', 'json',
    ]);
    expect(body).toEqual({ content: '# 方案', format: 'markdown', truncated: true });
  });

  it('follows Wiki node cursors before declaring an inventory complete', async () => {
    const { client, json } = setup([
      { wikiSpaces: [{ workspaceId: 'wiki-a' }] },
      { nodes: [{ nodeId: 'doc-a', name: 'A', modifiedTime: '2026-08-22T00:30:00Z' }], nextCursor: 'node-cursor-2' },
      { nodes: [{ nodeId: 'doc-b', name: 'B', modifiedTime: '2026-08-22T00:40:00Z' }] },
    ]);

    await expect(client.listWikiDocuments({ scope, window, pageSize: 30 }))
      .resolves.toMatchObject({ items: [
        expect.objectContaining({ documentId: 'doc-a' }),
        expect.objectContaining({ documentId: 'doc-b' }),
      ] });
    expect(json.mock.calls[2]![0]).toContain('node-cursor-2');
  });

  it('marks an exact Wiki node cap incomplete instead of reconciling a hidden next page', async () => {
    const { client } = setup([
      { wikiSpaces: [{ workspaceId: 'wiki-a' }] },
      {
        nodes: Array.from({ length: 500 }, (_, index) => ({
          nodeId: `doc-${index}`,
          name: `文档 ${index}`,
          modifiedTime: '2026-08-22T00:30:00Z',
        })),
        nextCursor: 'hidden-page',
      },
    ]);

    const result = await client.listWikiDocuments({ scope, window, pageSize: 500 });
    expect(result.items).toHaveLength(500);
    expect(result.truncated).toBe(true);
  });

  it('marks a Wiki inventory incomplete when any addressed node cannot be parsed', async () => {
    const { client } = setup([
      { wikiSpaces: [{ workspaceId: 'wiki-a' }] },
      { nodes: [
        { nodeId: 'doc-a', name: 'A', modifiedTime: '2026-08-22T00:30:00Z' },
        { nodeId: 'missing-required-fields' },
      ] },
    ]);

    await expect(client.listWikiDocuments({ scope, window, pageSize: 30 }))
      .resolves.toEqual({
        items: [{
          documentId: 'doc-a', title: 'A', updatedAt: '2026-08-22T00:30:00.000Z', spaceId: 'wiki-a',
        }],
        truncated: true,
      });
  });

  it('maps minutes list/summary/transcription and follows transcript pagination', async () => {
    const { client, json } = setup([
      {
        data: {
          minutes: [
            { taskUuid: 'minutes-a', title: '周会', startTime: '2026-08-22T00:10:00Z', duration: 600 },
            { taskUuid: 'minutes-old', title: '旧会', startTime: '2026-08-21T00:10:00Z' },
          ],
          complete: true,
        },
        meta: { pagination: { endpoint_exhausted: true, pages: 2, items: 2 } },
      },
      { result: { fullSummary: '核心结论' } },
      {
        result: {
          paragraphList: [{ speakerNick: '甲', paragraph: '第一段', sentences: [{ text: '补充' }] }],
          hasNext: true,
          nextToken: 'transcript-cursor-2',
        },
      },
      { result: { paragraphList: [{ speakerNick: '乙', paragraph: '第二段' }], hasNext: false } },
    ]);

    const list = await client.listMinutes({ scope, window, pageSize: 20 });
    const summary = await client.getMinutesSummary({ scope, minutesId: 'minutes-a' });
    const transcript = await client.getMinutesTranscript({ scope, minutesId: 'minutes-a' });

    expect(json.mock.calls[0]![0]).toEqual([
      'dws', 'minutes', '+list-all', '--limit', '20',
      '--page-all', '--page-limit', '100',
      '--profile', 'corp:user', '--format', 'json',
    ]);
    expect(list).toEqual({
      items: [{
        minutesId: 'minutes-a', title: '周会', startedAt: '2026-08-22T00:10:00.000Z',
        durationSeconds: 600,
      }],
    });
    expect(json.mock.calls[1]![0]).toEqual([
      'dws', 'minutes', 'get', 'summary', '--id', 'minutes-a',
      '--profile', 'corp:user', '--format', 'json',
    ]);
    expect(summary).toEqual({ content: '核心结论' });
    expect(json.mock.calls[3]![0]).toContain('transcript-cursor-2');
    expect(transcript).toEqual({ content: '甲: 第一段 补充\n乙: 第二段' });
  });

  it('fails closed when a v1.0.60 minutes inventory is not complete and has no safe cursor', async () => {
    const { client } = setup([{
      data: { minutes: [], complete: false },
      meta: { pagination: { endpoint_exhausted: true, pages: 1, items: 0 } },
    }]);

    await expect(client.listMinutes({ scope, window, pageSize: 20 }))
      .resolves.toEqual({ items: [], truncated: true });
  });

  it('marks transcript clipping explicit when the adapter character bound is reached', async () => {
    const json = vi.fn().mockResolvedValue({
      result: { paragraphList: [{ paragraph: 'abcdefghij' }], hasNext: true, nextToken: 'next' },
    });
    const client = new DwsCliContextClient({ executor: { json }, maxTranscriptCharacters: 5 });

    await expect(client.getMinutesTranscript({ scope, minutesId: 'minutes-a' }))
      .resolves.toEqual({ content: 'abcde', truncated: true });
    expect(json).toHaveBeenCalledTimes(1);
  });

  it('never logs or rethrows credential values supplied to the executor environment', async () => {
    const secret = 'super-secret-client-value';
    const logger = { warn: vi.fn() };
    const executor: DwsCliJsonExecutor = {
      json: vi.fn().mockRejectedValue(new Error(`client_secret=${secret} Bearer ${secret}`)),
    };
    const client = new DwsCliContextClient({
      executor,
      resolveExecution: () => ({ env: { DWS_CLIENT_SECRET: secret } }),
      logger,
    });

    const error = await client.listMinutes({ scope, window, pageSize: 10 })
      .then(() => undefined, value => value instanceof Error ? value : new Error(String(value)));
    expect(error?.message).not.toContain(secret);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
    expect(logger.warn).toHaveBeenCalledWith('DWS context command failed', expect.objectContaining({
      operation: 'minutes.list',
      error: expect.stringContaining('[REDACTED]'),
    }));
    expect(vi.mocked(executor.json).mock.calls[0]![1]).toMatchObject({
      env: { DWS_CLIENT_SECRET: secret },
      context: { ...scope, operation: 'minutes.list' },
    });
  });
});
