import { describe, expect, it } from 'vitest';

import {
  CONTRACT_VERSION,
  CONTRACT_VERSION_V2,
  negotiateContractVersion,
  V2_JWT_TYP,
  V2_TTL_SECONDS,
} from '../types/constants.js';

describe('V1/V2 显式版本协商', () => {
  it('保留 V1 常量并优先选择双方支持的 V2', () => {
    expect(CONTRACT_VERSION).toBe(1);
    expect(CONTRACT_VERSION_V2).toBe(2);
    expect(negotiateContractVersion([1, 2])).toBe(2);
    expect(negotiateContractVersion([1])).toBe(1);
    expect(negotiateContractVersion([3])).toBeNull();
  });

  it('六种 token 类型互斥且 TTL 固定', () => {
    expect(new Set(Object.values(V2_JWT_TYP)).size).toBe(6);
    expect(V2_TTL_SECONDS.workloadAccessToken).toBe(300);
    expect(V2_TTL_SECONDS.clientAssertion).toBe(60);
    expect(V2_TTL_SECONDS.authorizationCode).toBe(60);
  });
});
