import { describe, expect, it, vi } from 'vitest';

import { resolveEffectiveApprovalPolicy } from '../runtime/rawRuntimeRunDispatch.js';

describe('resolveEffectiveApprovalPolicy', () => {
  const identity = { userId: 'user-1', username: 'alice' };

  it('客户端未携带策略时使用账户级全部授权偏好', () => {
    const resolveUserAutoApproveTools = vi.fn(() => true);

    expect(resolveEffectiveApprovalPolicy(
      { resolveUserAutoApproveTools },
      undefined,
      identity,
    )).toEqual({ autoApproveTools: true });
    expect(resolveUserAutoApproveTools).toHaveBeenCalledWith(identity);
  });

  it('账户关闭全部授权时保留人工审批', () => {
    expect(resolveEffectiveApprovalPolicy(
      { resolveUserAutoApproveTools: () => false },
      undefined,
      identity,
    )).toBeUndefined();
  });

  it('兼容旧客户端显式携带的授权策略', () => {
    const resolveUserAutoApproveTools = vi.fn(() => false);

    expect(resolveEffectiveApprovalPolicy(
      { resolveUserAutoApproveTools },
      { autoApproveTools: true },
      identity,
    )).toEqual({ autoApproveTools: true });
    expect(resolveUserAutoApproveTools).not.toHaveBeenCalled();
  });

  it('用户不存在或偏好读取失败时 fail-closed', () => {
    expect(resolveEffectiveApprovalPolicy(
      { resolveUserAutoApproveTools: () => true },
      undefined,
      undefined,
    )).toBeUndefined();
    expect(resolveEffectiveApprovalPolicy(
      { resolveUserAutoApproveTools: () => { throw new Error('store unavailable'); } },
      undefined,
      identity,
    )).toBeUndefined();
  });
});
