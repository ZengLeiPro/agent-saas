import { describe, expect, it } from 'vitest';
import {
  INSUFFICIENT_CREDITS_FAILURE_MESSAGE,
  formatRuntimeFailureMessage,
  isInsufficientCreditsFailure,
} from './runtimeErrorMessage';

describe('runtimeErrorMessage', () => {
  it('把积分硬封顶识别为独立的余额状态', () => {
    const error = '组织积分余额不足，当前计费策略已启用硬封顶。';

    expect(isInsufficientCreditsFailure(error)).toBe(true);
    expect(formatRuntimeFailureMessage(error)).toBe(INSUFFICIENT_CREDITS_FAILURE_MESSAGE);
  });

  it('不把普通运行错误误判为积分不足', () => {
    expect(isInsufficientCreditsFailure('Responses API HTTP 500: EOF')).toBe(false);
  });
});
