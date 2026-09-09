import type { UserPreferences } from '@agent/shared';

export type ApprovalTier = 'ask' | 'low-risk' | 'full';

export function resolveApprovalTier(preferences?: UserPreferences | null): ApprovalTier {
  if (preferences?.authorizationModeEnabled === false) {
    return preferences.lowRiskToolsAutoApproveEnabled === true ? 'low-risk' : 'ask';
  }
  return 'full';
}

export function preferencesForApprovalTier(tier: ApprovalTier): UserPreferences {
  return {
    authorizationModeEnabled: tier === 'full',
    lowRiskToolsAutoApproveEnabled: tier === 'low-risk',
  };
}
