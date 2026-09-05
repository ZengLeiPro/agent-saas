import { describe, expect, it } from 'vitest';

import { queuedMessageBarTitle, selectQueuedMessageEntries } from './queuedMessageBar';
import type { ChatQueueItem } from './chatQueue';

const item = (patch: Partial<ChatQueueItem>): ChatQueueItem => ({
  sessionId: 's1',
  clientMsgId: 'c1',
  runId: 'r1',
  sourceRunId: 'r1',
  deliveryMode: 'queue',
  status: 'queued',
  targetRunId: 'target-1',
  content: '补充一条',
  ...patch,
});

describe('selectQueuedMessageEntries 插话队列条投影', () => {
  it('只收编有 targetRunId 的真实插话', () => {
    const entries = selectQueuedMessageEntries([
      item({ clientMsgId: 'interjection' }),
      item({ clientMsgId: 'standalone', targetRunId: undefined }),
    ]);
    expect(entries.map((entry) => entry.clientMsgId)).toEqual(['interjection']);
  });

  it('按会话过滤，跨会话条目不串台', () => {
    const entries = selectQueuedMessageEntries(
      [item({ clientMsgId: 'mine' }), item({ clientMsgId: 'other', sessionId: 's2' })],
      's1',
    );
    expect(entries.map((entry) => entry.clientMsgId)).toEqual(['mine']);
  });

  it('running / completed / steered 不进队列条', () => {
    const entries = selectQueuedMessageEntries([
      item({ clientMsgId: 'a', status: 'running' }),
      item({ clientMsgId: 'b', status: 'completed' }),
      item({ clientMsgId: 'c', status: 'steered' }),
    ]);
    expect(entries).toEqual([]);
  });

  it('状态文案与 Web 队列条一致', () => {
    const [queued, positioned, steer, cancelled, failed] = selectQueuedMessageEntries([
      item({ clientMsgId: 'a' }),
      item({ clientMsgId: 'b', queuePosition: 2 }),
      item({ clientMsgId: 'c', deliveryMode: 'steer' }),
      item({ clientMsgId: 'd', status: 'cancelled' }),
      item({ clientMsgId: 'e', status: 'failed', reason: '目标运行已结束' }),
    ]);
    expect(queued.statusLabel).toBe('已排队');
    expect(positioned.statusLabel).toBe('已排队 · 第 2 位');
    expect(steer.statusLabel).toBe('已发送，将在当前步骤结束后处理');
    expect(cancelled.statusLabel).toBe('已撤销');
    expect(failed.statusLabel).toBe('目标运行已结束');
  });

  it('只有 queued 可撤回；cancel_pending 标记为撤回中', () => {
    const [queued, cancelPending] = selectQueuedMessageEntries([
      item({ clientMsgId: 'a' }),
      item({ clientMsgId: 'b', status: 'cancel_pending' }),
    ]);
    expect(queued).toMatchObject({
      cancellable: true,
      cancelling: false,
      pending: true,
      settled: false,
    });
    expect(cancelPending).toMatchObject({
      cancellable: false,
      cancelling: true,
      pending: true,
      settled: false,
    });
  });

  it('附件数量与终态标记随条目下发', () => {
    const [entry] = selectQueuedMessageEntries([
      item({
        attachments: [{ attachmentId: 'a1', name: 'a.png' }],
        status: 'failed',
      }),
    ]);
    expect(entry.attachmentCount).toBe(1);
    expect(entry.settled).toBe(true);
    expect(entry.pending).toBe(false);
  });

  it('标题只数仍在等待的条目', () => {
    const entries = selectQueuedMessageEntries([
      item({ clientMsgId: 'a' }),
      item({ clientMsgId: 'b', status: 'cancel_pending' }),
      item({ clientMsgId: 'c', status: 'cancelled' }),
    ]);
    expect(queuedMessageBarTitle(entries)).toBe('排队中 · 2 条');
  });
});
