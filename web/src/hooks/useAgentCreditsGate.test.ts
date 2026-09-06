/**
 * §6.4 积分耗尽判定。重点是**不误伤**：加载中、内部 / 未开启计费的组织都不该被降级。
 */
import { describe, expect, it } from 'vitest';

import { CREDITS_EXHAUSTED_NOTICE, isAgentCreditsExhausted } from './useAgentCreditsGate';

describe('isAgentCreditsExhausted', () => {
  it('额度 <= 0 判为耗尽', () => {
    expect(isAgentCreditsExhausted({ credits: 0, source: 'tenant' })).toBe(true);
    expect(isAgentCreditsExhausted({ credits: -5, source: 'tenant' })).toBe(true);
    expect(isAgentCreditsExhausted({ credits: 0, source: 'member' })).toBe(true);
  });

  it('还有额度不降级', () => {
    expect(isAgentCreditsExhausted({ credits: 0.5, source: 'member' })).toBe(false);
    expect(isAgentCreditsExhausted({ credits: 100, source: 'tenant' })).toBe(false);
  });

  it('allowance 为 null（加载中 / 计费未开启 / internal）一律不降级', () => {
    expect(isAgentCreditsExhausted(null)).toBe(false);
  });

  it('文案与 §6.4 一字不差', () => {
    expect(CREDITS_EXHAUSTED_NOTICE).toBe('本组织的 AI 额度已用完，已通知管理员');
  });
});
