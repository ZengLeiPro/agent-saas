import { describe, expect, it } from 'vitest';
import {
  classifyModelFailure,
  customerSafeRuntimeError,
  mapRuntimeFailureToCanonical,
  POLICY_REJECTION_CUSTOMER_MESSAGE,
} from '../runtime/runtimeFailure.js';

describe('runtimeFailure', () => {
  it('仅把 permanent cyber_policy 归类为策略拒绝', () => {
    expect(classifyModelFailure('cyber_policy', 'permanent_error')).toEqual({
      failureKind: 'policy_rejection',
      recoveryAction: 'switch_model',
    });
    expect(classifyModelFailure('cyber_policy', 'retry_budget_exhausted')).toBeUndefined();
  });

  it('策略拒绝覆盖原始 provider 错误，普通失败保持原消息', () => {
    const rawError = 'Responses API HTTP 400: cyber_policy request_id=req-secret';
    expect(customerSafeRuntimeError(rawError, 'policy_rejection')).toBe(POLICY_REJECTION_CUSTOMER_MESSAGE);
    expect(customerSafeRuntimeError(rawError, undefined)).toBe(rawError);
  });

  it('adapts existing runtime authority into canonical safe semantics without raw provider text', () => {
    const failure = mapRuntimeFailureToCanonical({
      failureKind: 'policy_rejection',
      correlationId: 'corr-runtime-123',
      legacyMessage: 'token=RUNTIME_SECRET /workspace/private',
    });
    expect(failure).toMatchObject({
      kind: 'capability_unavailable',
      correlationId: 'corr-runtime-123',
      recoveryAction: { kind: 'contact-admin' },
      terminal: true,
    });
    expect(JSON.stringify(failure)).not.toMatch(/RUNTIME_SECRET|workspace/);
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
