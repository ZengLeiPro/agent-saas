import { describe, expect, it } from 'vitest';
import {
  INSUFFICIENT_CREDITS_FAILURE_MESSAGE,
  POLICY_REJECTION_FAILURE_MESSAGE,
  formatRuntimeFailureMessage,
  isInsufficientCreditsFailure,
  isSameRunMessage,
} from './runtimeErrorMessage';

describe('runtimeErrorMessage', () => {
  it('把积分硬封顶识别为独立的余额状态', () => {
    const error = '组织积分余额不足，当前计费策略已启用硬封顶。';

    expect(isInsufficientCreditsFailure(error)).toBe(true);
    expect(formatRuntimeFailureMessage(error)).toBe(INSUFFICIENT_CREDITS_FAILURE_MESSAGE);
  });

  it('仅依据结构化 failureKind 显示策略拒绝文案', () => {
    expect(formatRuntimeFailureMessage('Responses API HTTP 200: cyber_policy', 'policy_rejection'))
      .toBe(POLICY_REJECTION_FAILURE_MESSAGE);
    expect(formatRuntimeFailureMessage('仅错误文本包含 cyber_policy'))
      .not.toBe(POLICY_REJECTION_FAILURE_MESSAGE);
  });

  it('实时终态只把同 run 同文案视为重复', () => {
    const message = { runId: 'run-1', content: POLICY_REJECTION_FAILURE_MESSAGE };
    expect(isSameRunMessage(message, 'run-1', POLICY_REJECTION_FAILURE_MESSAGE)).toBe(true);
    expect(isSameRunMessage(message, 'run-2', POLICY_REJECTION_FAILURE_MESSAGE)).toBe(false);
  });

  it('不把普通运行错误误判为积分不足', () => {
    expect(isInsufficientCreditsFailure('Responses API HTTP 500: EOF')).toBe(false);
  });
});
