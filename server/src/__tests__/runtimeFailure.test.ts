import { describe, expect, it } from 'vitest';
import {
  classifyModelFailure,
  customerSafeRuntimeError,
  mapRuntimeFailureToCanonical,
  parseQuotaResetAt,
  quotaExhaustedReasonCode,
  POLICY_REJECTION_CUSTOMER_MESSAGE,
  QUOTA_EXHAUSTED_CUSTOMER_MESSAGE,
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
    // 火山 Ark（2026-08-03 生产样本）
    'QuotaExceeded', 'AccountQuotaExceeded',
    // OpenAI / Codex（2026-08-24 生产样本）
    'usage_limit_reached', 'insufficient_quota', 'billing_hard_limit_reached',
  ])('上游结构化配额错误码 %s 归类为 quota_exhausted 并建议换模型', (errorCode) => {
    expect(quotaExhaustedReasonCode(errorCode)).toBe('quota_exhausted');
    expect(classifyModelFailure(errorCode, 'permanent_error')).toEqual({
      failureKind: 'quota_exhausted',
      recoveryAction: 'switch_model',
    });
  });

  it('配额型终态用客户面文案覆盖原始技术串', () => {
    const raw = 'Responses API HTTP 429: usage_limit_reached request_id=req-secret';
    expect(customerSafeRuntimeError(raw, 'quota_exhausted')).toBe(QUOTA_EXHAUSTED_CUSTOMER_MESSAGE);
  });

  it('classifyModelFailure 透传解析到的 quotaResetAt', () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    expect(classifyModelFailure('usage_limit_reached', 'permanent_error', at)).toEqual({
      failureKind: 'quota_exhausted',
      recoveryAction: 'switch_model',
      quotaResetAt: at,
    });
  });

  it('parseQuotaResetAt 只读结构化字段：resets_at(秒/毫秒) / resets_in_seconds / Retry-After', () => {
    const now = Date.parse('2026-08-24T04:19:00.000Z');
    const expected = new Date(now + 3600_000).toISOString();
    expect(parseQuotaResetAt({ resetsAt: (now + 3600_000) / 1000, nowMs: now })).toBe(expected);
    expect(parseQuotaResetAt({ resetsAt: now + 3600_000, nowMs: now })).toBe(expected);
    expect(parseQuotaResetAt({ resetsInSeconds: 3600, nowMs: now })).toBe(expected);
    expect(parseQuotaResetAt({ retryAfterSeconds: 3600, nowMs: now })).toBe(expected);
    // 过期 / 越界 / 非数字一律不填（宁可不显示，也不显示错的时刻）
    expect(parseQuotaResetAt({ resetsInSeconds: -10, nowMs: now })).toBeUndefined();
    expect(parseQuotaResetAt({ resetsInSeconds: 48 * 3600, nowMs: now })).toBeUndefined();
    expect(parseQuotaResetAt({ resetsAt: 'later', nowMs: now })).toBeUndefined();
    expect(parseQuotaResetAt({ nowMs: now })).toBeUndefined();
  });

  it('配额型 canonical 归一保留 quota_exhausted 与 resetAt', () => {
    const at = new Date(Date.now() + 2 * 3600_000).toISOString();
    const failure = mapRuntimeFailureToCanonical({ failureKind: 'quota_exhausted', quotaResetAt: at });
    expect(failure.kind).toBe('quota_exhausted');
    expect(failure.resetAt).toBe(at);
    expect(failure.retryable).toBe(false);
  });

  it.each([
    'MODEL_NETWORK_ERROR',
    'rate_limit_exceeded',
    'MODEL_SSE_EOF_WITHOUT_TERMINAL',
    'server_is_overloaded',
    'invalid_prompt',
    'Request blocked: cyber_policy',
  ])('普通、瞬时或非 allowlist 错误 %s 不归类为策略拒绝/配额耗尽', (errorCode) => {
    expect(classifyModelFailure(errorCode, 'permanent_error')).toBeUndefined();
  });

  it('只认结构化错误码：自由文本里的配额措辞不参与归类（2026-08-23 红线）', () => {
    expect(quotaExhaustedReasonCode('You have exceeded the 5-hour usage quota')).toBeUndefined();
    expect(quotaExhaustedReasonCode('rate_limit_exceeded')).toBeUndefined();
    expect(quotaExhaustedReasonCode(undefined)).toBeUndefined();
  });
});
