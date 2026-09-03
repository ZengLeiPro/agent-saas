import { describe, expect, it } from 'vitest';
import { shouldProjectInteractionEvent } from './interactionProjectionFence';

describe('Interaction session projection fence', () => {
  it('A→B 切换后拒绝 A 的 pending snapshot 与 resolved', () => {
    expect(shouldProjectInteractionEvent(
      { type: 'pending_interactions', sessionId: 'A', interactions: [] },
      'B',
      'B',
    )).toBe(false);
    expect(shouldProjectInteractionEvent(
      { type: 'interaction_resolved', sessionId: 'A', interactionId: 'interaction-1' },
      'B',
      'B',
    )).toBe(false);
  });

  it('拒绝缺会话归属的恢复快照，只接受当前会话', () => {
    expect(shouldProjectInteractionEvent(
      { type: 'pending_interactions', interactions: [] },
      'B',
      'B',
    )).toBe(false);
    expect(shouldProjectInteractionEvent(
      { type: 'pending_interactions', sessionId: 'B', interactions: [] },
      'B',
      'B',
    )).toBe(true);
  });

  it('旧协议 live interaction 仅投影到当前 attached stream 会话', () => {
    const event = {
      type: 'ask_user' as const,
      interactionId: 'interaction-1',
      questions: [],
    };
    expect(shouldProjectInteractionEvent(event, 'B', 'A')).toBe(false);
    expect(shouldProjectInteractionEvent(event, 'B', 'B')).toBe(true);
  });
});
