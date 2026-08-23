import { describe, expect, it } from 'vitest';
import { classifyModelFailure } from '../runtime/runtimeFailure.js';

describe('runtimeFailure', () => {
  it('仅把 permanent cyber_policy 归类为策略拒绝', () => {
    expect(classifyModelFailure('cyber_policy', 'permanent_error')).toEqual({
      failureKind: 'policy_rejection',
      recoveryAction: 'switch_model',
    });
    expect(classifyModelFailure('cyber_policy', 'retry_budget_exhausted')).toBeUndefined();
  });

  it.each([
    'MODEL_NETWORK_ERROR',
    'rate_limit_exceeded',
    'MODEL_SSE_EOF_WITHOUT_TERMINAL',
    'server_is_overloaded',
    'invalid_prompt',
    'Request blocked: cyber_policy',
  ])('普通、瞬时或非 allowlist 错误 %s 不归类为策略拒绝', (errorCode) => {
    expect(classifyModelFailure(errorCode, 'permanent_error')).toBeUndefined();
  });
});
