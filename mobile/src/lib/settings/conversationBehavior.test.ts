import { describe, expect, it } from 'vitest';

import { preferencesForApprovalTier, resolveApprovalTier } from './conversationBehavior';

describe('conversationBehavior', () => {
  it('按与 Web 相同的优先级解析三档操作确认', () => {
    expect(resolveApprovalTier()).toBe('full');
    expect(resolveApprovalTier({ authorizationModeEnabled: false })).toBe('ask');
    expect(
      resolveApprovalTier({
        authorizationModeEnabled: false,
        lowRiskToolsAutoApproveEnabled: true,
      }),
    ).toBe('low-risk');
    expect(
      resolveApprovalTier({
        authorizationModeEnabled: true,
        lowRiskToolsAutoApproveEnabled: true,
      }),
    ).toBe('full');
  });

  it('将三档选择映射为服务端已有偏好字段', () => {
    expect(preferencesForApprovalTier('ask')).toEqual({
      authorizationModeEnabled: false,
      lowRiskToolsAutoApproveEnabled: false,
    });
    expect(preferencesForApprovalTier('low-risk')).toEqual({
      authorizationModeEnabled: false,
      lowRiskToolsAutoApproveEnabled: true,
    });
    expect(preferencesForApprovalTier('full')).toEqual({
      authorizationModeEnabled: true,
      lowRiskToolsAutoApproveEnabled: false,
    });
  });
});
