import { describe, expect, it } from 'vitest';

import {
  debugModeFeaturesFromTenantSettings,
  resolveLegacySkillIdForPreferenceProjection,
} from '../app/runtimeGovernanceStores.js';

describe('debugModeFeaturesFromTenantSettings', () => {
  it('治理投影只保留 Tenant settings 的显式值，旧 Policy 不参与反向覆盖', () => {
    expect(debugModeFeaturesFromTenantSettings({ debugModeAllowed: true, debugModeEnabled: undefined })).toEqual({
      debugModeAllowed: true,
      debugModeEnabled: false,
    });
  });
});

describe('resolveLegacySkillIdForPreferenceProjection', () => {
  it('把有版本映射的个人技能还原为 legacy skill id', () => {
    expect(resolveLegacySkillIdForPreferenceProjection(
      'personal_f08ca1f2500231e86f59063257f9e8d8',
      { legacySkillId: 'my-private-skill' },
    )).toBe('my-private-skill');
  });

  it('跳过缺失 governed resource 的个人技能，避免 personal hash 持续二次哈希', () => {
    expect(resolveLegacySkillIdForPreferenceProjection(
      'personal_f08ca1f2500231e86f59063257f9e8d8',
    )).toBeUndefined();
  });

  it('缺少版本映射时仍保留普通共享技能 id', () => {
    expect(resolveLegacySkillIdForPreferenceProjection('dws')).toBe('dws');
    expect(resolveLegacySkillIdForPreferenceProjection('personal_workspace_helper')).toBe(
      'personal_workspace_helper',
    );
  });
});
