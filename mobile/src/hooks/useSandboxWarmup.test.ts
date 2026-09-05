import { describe, expect, it } from 'vitest';
import { nextWarmupState, type WarmupInputState } from './useSandboxWarmup';

const initial: WarmupInputState = { sessionId: 's-1', hasValidText: false };

describe('nextWarmupState', () => {
  it('同一会话内首次敲出有效文本触发预热', () => {
    expect(nextWarmupState(initial, 's-1', 'hi')).toEqual({
      next: { sessionId: 's-1', hasValidText: true },
      transition: 'warmup',
    });
  });

  it('纯空白不算有效文本', () => {
    expect(nextWarmupState(initial, 's-1', '   ').transition).toBe('none');
  });

  it('继续输入不重复触发', () => {
    expect(
      nextWarmupState({ sessionId: 's-1', hasValidText: true }, 's-1', 'hello').transition,
    ).toBe('none');
  });

  it('清空后重新武装', () => {
    expect(nextWarmupState({ sessionId: 's-1', hasValidText: true }, 's-1', '')).toEqual({
      next: { sessionId: 's-1', hasValidText: false },
      transition: 'rearm',
    });
  });

  it('切换会话只重新武装，不把既有草稿当成首字', () => {
    expect(nextWarmupState(initial, 's-2', '既有草稿')).toEqual({
      next: { sessionId: 's-2', hasValidText: false },
      transition: 'rearm',
    });
  });

  it('尚未落地会话（sessionId 为 null）不预热', () => {
    expect(nextWarmupState({ sessionId: null, hasValidText: false }, null, 'hi')).toEqual({
      next: { sessionId: null, hasValidText: true },
      transition: 'none',
    });
  });
});
