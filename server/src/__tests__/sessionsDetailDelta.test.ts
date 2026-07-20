import { describe, expect, it } from 'vitest';

import { buildSessionDetailPayload } from '../routes/sessions.js';
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
    })),
  };
}

describe('buildSessionDetailPayload', () => {
  it('无游标时返回完整快照和最新 cursor', () => {
    const detail = snapshot(40);
    const payload = buildSessionDetailPayload(detail);

    expect(payload.mode).toBe('full');
    expect(payload.blocks).toHaveLength(40);
    expect(payload.cursor).toBe('line-40');
  });

  it('游标命中时只返回包含重叠尾部的增量', () => {
    const payload = buildSessionDetailPayload(snapshot(50), 'line-40');

    expect(payload.mode).toBe('delta');
    expect(payload.after).toBe('line-40');
    expect(payload.blocks[0]?.id).toBe('line-9');
    expect(payload.blocks.at(-1)?.id).toBe('line-50');
    expect(payload.cursor).toBe('line-50');
  });

  it('游标因 compact 或重写失配时自动回退完整快照', () => {
    const payload = buildSessionDetailPayload(snapshot(12), 'line-999');

    expect(payload.mode).toBe('full');
    expect(payload).not.toHaveProperty('after');
    expect(payload.blocks).toHaveLength(12);
  });
});
