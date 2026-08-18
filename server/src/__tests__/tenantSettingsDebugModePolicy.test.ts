import { describe, expect, it } from 'vitest';

import { DEFAULT_TENANT_SETTINGS } from '../data/tenants/types.js';
import { tenantSettingsPolicyError } from '../routes/tenantSettingsValidation.js';

describe('tenantSettingsPolicyError 调试模式继承', () => {
  it('组织管理员不能修改平台授权', () => {
    const current = structuredClone(DEFAULT_TENANT_SETTINGS);
    const patch = structuredClone(current);
    patch.features.debugModeAllowed = true;

    expect(tenantSettingsPolicyError(patch, current, false)).toEqual({
      status: 403,
      error: '调试模式平台授权仅平台管理员可配置',
    });
  });

  it('平台关闭授权时强制关闭组织开关', () => {
    const current = structuredClone(DEFAULT_TENANT_SETTINGS);
    current.features.debugModeAllowed = true;
    current.features.debugModeEnabled = true;
    const patch = structuredClone(current);
    patch.features.debugModeAllowed = false;

    expect(tenantSettingsPolicyError(patch, current, true)).toBeNull();
    expect(patch.features.debugModeEnabled).toBe(false);
  });

  it('组织可在平台授权后关闭自己的开关', () => {
    const current = structuredClone(DEFAULT_TENANT_SETTINGS);
    current.features.debugModeAllowed = true;
    current.features.debugModeEnabled = true;
    const patch = structuredClone(current);
    patch.features.debugModeEnabled = false;

    expect(tenantSettingsPolicyError(patch, current, false)).toBeNull();
    expect(patch.features.debugModeAllowed).toBe(true);
    expect(patch.features.debugModeEnabled).toBe(false);
  });

  it('旧数据缺少组织开关时，平台开启授权不会自动打开组织开关', () => {
    const current = structuredClone(DEFAULT_TENANT_SETTINGS);
    current.features.debugModeAllowed = false;
    delete current.features.debugModeEnabled;
    const patch = structuredClone(current);
    patch.features.debugModeAllowed = true;
    delete patch.features.debugModeEnabled;

    expect(tenantSettingsPolicyError(patch, current, true)).toBeNull();
    expect(patch.features.debugModeEnabled).toBe(false);
  });

  it('平台未授权时组织管理员越权开启组织开关会被拒绝', () => {
    const current = structuredClone(DEFAULT_TENANT_SETTINGS);
    current.features.debugModeAllowed = false;
    current.features.debugModeEnabled = false;
    const patch = structuredClone(current);
    patch.features.debugModeEnabled = true;

    expect(tenantSettingsPolicyError(patch, current, false)).toEqual({
      status: 400,
      error: '平台尚未授予调试模式，组织不能开启',
    });
  });
});
