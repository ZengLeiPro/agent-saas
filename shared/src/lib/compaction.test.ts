import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  asCompactionItem,
  compactionDoneReplacement,
  compactionItemFromBlock,
  createCompactionDoneItem,
  createCompactionRunningItem,
  injectCompactionMessages,
  isCompactionItem,
  isCompactionStatusEvent,
  type CompactionMessageItem,
} from './compaction';
import type { ApiTranscriptBlock } from '../types/session';
import type { MessageItem } from '../types/message';

/** 允许携带 ApiTranscriptBlock 未收编的服务端扩展字段（kind='compaction' / coveredEventCount） */
const block = (patch: Record<string, unknown> & { id: string }): ApiTranscriptBlock =>
  ({
    kind: 'text',
    title: '',
    defaultOpen: false,
    content: '',
    ...patch,
  }) as unknown as ApiTranscriptBlock;

const textMessage = (id: string): MessageItem => ({ id, type: 'text', content: id }) as MessageItem;

const asItem = (value: unknown): CompactionMessageItem => value as CompactionMessageItem;

describe('compaction 识别', () => {
  it('asCompactionItem 只认 type=compaction', () => {
    expect(asCompactionItem({ id: 'c1', type: 'compaction' })).toEqual({
      id: 'c1',
      type: 'compaction',
    });
    expect(asCompactionItem({ id: 'm1', type: 'text' })).toBeNull();
    expect(asCompactionItem(null)).toBeNull();
    expect(asCompactionItem('compaction')).toBeNull();
  });

  it('isCompactionItem 与 asCompactionItem 判定等价', () => {
    for (const value of [{ type: 'compaction' }, { type: 'text' }, null, undefined, 0, []]) {
      expect(isCompactionItem(value)).toBe(asCompactionItem(value) !== null);
    }
  });

  it('isCompactionStatusEvent 只认 compaction_status', () => {
    expect(isCompactionStatusEvent({ type: 'compaction_status', phase: 'started' })).toBe(true);
    expect(isCompactionStatusEvent({ type: 'text' })).toBe(false);
    expect(isCompactionStatusEvent(undefined)).toBe(false);
  });
});

describe('compaction 状态条构造（web API）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-04T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('running 状态条不带 summary/条数', () => {
    const item = asItem(createCompactionRunningItem());
    expect(item.type).toBe('compaction');
    expect(item.status).toBe('running');
    expect(item.summary).toBeUndefined();
    expect(item.coveredEventCount).toBeUndefined();
    expect(item.timestamp).toBe(Date.parse('2026-09-04T00:00:00Z'));
  });

  it('done 分界线透传 summary 与条数，缺省字段不写入', () => {
    const full = asItem(createCompactionDoneItem({ summary: '摘要', coveredEventCount: 12 }));
    expect(full.status).toBe('done');
    expect(full.summary).toBe('摘要');
    expect(full.coveredEventCount).toBe(12);

    const bare = asItem(createCompactionDoneItem());
    expect(bare.status).toBe('done');
    expect('summary' in bare).toBe(false);
    expect('coveredEventCount' in bare).toBe(false);

    const skipped = asItem(createCompactionDoneItem({ skipped: true, note: '历史太短' }));
    expect('summary' in skipped).toBe(false);
  });

  it('compactionDoneReplacement 保留原 id', () => {
    const replaced = asItem(compactionDoneReplacement('c-1', { coveredEventCount: 3 }));
    expect(replaced.id).toBe('c-1');
    expect(replaced.status).toBe('done');
    expect(replaced.coveredEventCount).toBe(3);
  });
});

describe('compactionItemFromBlock', () => {
  it('content → summary，coveredEventCount / tsMs 按存在性写入', () => {
    const item = asItem(
      compactionItemFromBlock(
        block({ id: 'b1', content: '摘要正文', tsMs: 1700, coveredEventCount: 8 }),
      ),
    );
    expect(item).toEqual({
      id: 'b1',
      type: 'compaction',
      status: 'done',
      summary: '摘要正文',
      coveredEventCount: 8,
      timestamp: 1700,
    });
  });

  it('空 content / 非数字条数不写入对应字段', () => {
    const item = asItem(compactionItemFromBlock(block({ id: 'b2', content: '' })));
    expect(item).toEqual({ id: 'b2', type: 'compaction', status: 'done' });
  });
});

describe('injectCompactionMessages（mobile API）', () => {
  it('没有 compaction 块时原样返回同一引用', () => {
    const msgs = [textMessage('a')];
    const blocks = [block({ id: 'a' })];
    expect(injectCompactionMessages(blocks, msgs)).toBe(msgs);
  });

  it('按 transcript 时序把分界线插到对应位置', () => {
    const blocks = [
      block({ id: 'a' }),
      block({ id: 'c1', kind: 'compaction', content: '摘要', tsMs: 42 }),
      block({ id: 'b' }),
    ];
    const out = injectCompactionMessages(blocks, [textMessage('a'), textMessage('b')]);
    expect(out.map((m) => m.id)).toEqual(['a', 'c1', 'b']);
    expect(asItem(out[1])).toEqual({
      id: 'c1',
      type: 'compaction',
      status: 'done',
      summary: '摘要',
      timestamp: 42,
    });
  });

  it('游标跳过派生消息（`${id}-file-N`），分界线落在派生消息之后', () => {
    const blocks = [block({ id: 'a' }), block({ id: 'c1', kind: 'compaction' })];
    const out = injectCompactionMessages(blocks, [
      textMessage('a'),
      textMessage('a-file-0'),
      textMessage('a-artifact'),
    ]);
    expect(out.map((m) => m.id)).toEqual(['a', 'a-file-0', 'a-artifact', 'c1']);
  });

  it('首块即压缩时插在最前', () => {
    const blocks = [block({ id: 'c0', kind: 'compaction' }), block({ id: 'a' })];
    const out = injectCompactionMessages(blocks, [textMessage('a')]);
    expect(out.map((m) => m.id)).toEqual(['c0', 'a']);
  });
});
