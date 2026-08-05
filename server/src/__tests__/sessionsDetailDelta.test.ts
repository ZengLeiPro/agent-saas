import { describe, expect, it } from 'vitest';

import { buildSessionDetailPayload, filterProjectedQueuedMessages } from '../routes/sessions.js';
import type { SessionShareSnapshot } from '../data/sessionShares/store.js';

function snapshot(blockCount: number): SessionShareSnapshot {
  return {
    sessionId: '11111111-1111-4111-8111-111111111111',
    stats: { lines: blockCount, parsedLines: blockCount, parseErrors: 0 },
    blocks: Array.from({ length: blockCount }, (_, index) => ({
      id: `line-${index + 1}`,
      kind: index % 2 === 0 ? 'prompt' as const : 'text' as const,
      title: '消息',
      defaultOpen: true,
      content: `内容 ${index + 1}`,
      raw: `重复内容 ${index + 1}`,
    })),
  };
}

describe('filterProjectedQueuedMessages', () => {
  it('不把已经投影进时间线、但 steering 行仍短暂 pending 的消息恢复为排队态', () => {
    const pending = [
      { sourceRunId: 'source-consumed', content: '已经发送' },
      { sourceRunId: 'source-pending', content: '仍在排队' },
    ];

    expect(filterProjectedQueuedMessages(pending, [
      { interjectionSourceRunId: 'source-consumed' },
      {},
    ])).toEqual([
      { sourceRunId: 'source-pending', content: '仍在排队' },
    ]);
  });
});

describe('buildSessionDetailPayload', () => {
  it('旧客户端未传 limit 时返回完整快照和最新 cursor', () => {
    const payload = buildSessionDetailPayload(snapshot(40));

    expect(payload.mode).toBe('full');
    expect(payload.blocks).toHaveLength(40);
    expect(payload.cursor).toBe('line-40');
    expect(payload.oldestCursor).toBe('line-1');
    expect(payload.historyComplete).toBe(true);
    expect(payload.blocks[0]).not.toHaveProperty('raw');
  });

  it('指定 limit 时只返回最新一页', () => {
    const payload = buildSessionDetailPayload(snapshot(240), { limit: 100 });

    expect(payload.mode).toBe('full');
    expect(payload.blocks).toHaveLength(100);
    expect(payload.blocks[0]?.id).toBe('line-141');
    expect(payload.oldestCursor).toBe('line-141');
    expect(payload.cursor).toBe('line-240');
    expect(payload.historyComplete).toBe(false);
  });

  it('before 命中时返回上一页和一个边界重叠块', () => {
    const payload = buildSessionDetailPayload(snapshot(240), {
      before: 'line-141',
      limit: 100,
    });

    expect(payload.mode).toBe('before');
    expect(payload.before).toBe('line-141');
    expect(payload.blocks).toHaveLength(101);
    expect(payload.blocks[0]?.id).toBe('line-41');
    expect(payload.blocks.at(-1)?.id).toBe('line-141');
    expect(payload.oldestCursor).toBe('line-41');
    expect(payload.historyComplete).toBe(false);
  });

  it('before 到达起点时标记历史完整', () => {
    const payload = buildSessionDetailPayload(snapshot(120), {
      before: 'line-21',
      limit: 100,
    });

    expect(payload.blocks[0]?.id).toBe('line-1');
    expect(payload.historyComplete).toBe(true);
  });

  it('游标命中时只返回包含重叠尾部的增量', () => {
    const payload = buildSessionDetailPayload(snapshot(50), { after: 'line-40' });

    expect(payload.mode).toBe('delta');
    expect(payload.after).toBe('line-40');
    expect(payload.blocks[0]?.id).toBe('line-9');
    expect(payload.blocks.at(-1)?.id).toBe('line-50');
    expect(payload.cursor).toBe('line-50');
  });

  it('游标落后超过 limit 时按最新一页回退，避免巨型增量', () => {
    const payload = buildSessionDetailPayload(snapshot(240), {
      after: 'line-100',
      limit: 100,
    });

    expect(payload.mode).toBe('full');
    expect(payload.blocks).toHaveLength(100);
    expect(payload.blocks[0]?.id).toBe('line-141');
    expect(payload.historyComplete).toBe(false);
  });

  it('游标因 compact 或重写失配时按 limit 回退最新一页', () => {
    const payload = buildSessionDetailPayload(snapshot(240), {
      after: 'line-999',
      limit: 100,
    });

    expect(payload.mode).toBe('full');
    expect(payload).not.toHaveProperty('after');
    expect(payload.blocks).toHaveLength(100);
    expect(payload.blocks[0]?.id).toBe('line-141');
  });
});
