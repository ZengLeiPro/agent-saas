import { describe, expect, it } from 'vitest';

import {
  GENERIC_FAILURE_MESSAGE,
  POLICY_FAILURE_MESSAGE,
  formatQuotaResetHint,
  selectClientFailureCopy,
} from './clientFailureCopy';
import { mapCanonicalError } from './canonicalError';
import type { ClientFailureCopyInput } from './clientFailureCopy';

const failedPresentation: ClientFailureCopyInput['presentation'] = {
  title: '运行出现问题',
  status: 'failed',
  statusLabel: '执行失败',
};

describe('selectClientFailureCopy 客户面失败文案', () => {
  it('普通失败提示发送「继续」', () => {
    const copy = selectClientFailureCopy({ presentation: failedPresentation });
    expect(copy.kind).toBe('generic');
    expect(copy.message).toBe(GENERIC_FAILURE_MESSAGE);
    expect(copy.action).toBeUndefined();
  });

  it('未知类 canonical 失败同样走通用口径', () => {
    const copy = selectClientFailureCopy({
      presentation: failedPresentation,
      canonicalFailure: mapCanonicalError({ code: 'not_a_known_code' }),
    });
    expect(copy.kind).toBe('generic');
    expect(copy.message).toBe(GENERIC_FAILURE_MESSAGE);
  });

  it('可重试失败保留 retry 动作', () => {
    const copy = selectClientFailureCopy({
      presentation: { ...failedPresentation, recoveryAction: { kind: 'retry', label: '重试' } },
    });
    expect(copy.action).toEqual({ kind: 'retry', label: '重试' });
  });

  it('结构化策略拒绝提示切换模型，绝不提示「继续」', () => {
    for (const input of [
      { presentation: failedPresentation, failureKind: 'policy_rejection' as const },
      { presentation: failedPresentation, recoveryAction: 'switch_model' as const },
      {
        presentation: {
          ...failedPresentation,
          recoveryAction: { kind: 'switch_model' as const, label: '切换模型' },
        },
      },
    ]) {
      const copy = selectClientFailureCopy(input);
      expect(copy.kind).toBe('policy');
      expect(copy.message).toBe(POLICY_FAILURE_MESSAGE);
      expect(copy.message).not.toContain('继续');
      expect(copy.action).toEqual({ kind: 'switch_model', label: '切换模型' });
    }
  });

  it('配额型 429 给出重置时间与切换模型入口', () => {
    const copy = selectClientFailureCopy({
      presentation: failedPresentation,
      canonicalFailure: mapCanonicalError({ status: 429, retryAfter: 90 }),
    });
    expect(copy.kind).toBe('quota');
    expect(copy.hint).toBe('额度将在 2 分钟后重置');
    expect(copy.action).toEqual({ kind: 'switch_model', label: '切换模型' });
  });

  it('没有重置时间时不编造', () => {
    const copy = selectClientFailureCopy({
      presentation: failedPresentation,
      canonicalFailure: mapCanonicalError({ status: 429 }),
    });
    expect(copy.kind).toBe('quota');
    expect(copy.hint).toBeUndefined();
  });

  it('取消不当失败处理，也不提示继续', () => {
    const copy = selectClientFailureCopy({
      presentation: { title: '运行已取消', status: 'cancelled', statusLabel: '已取消' },
      severity: 'cancelled',
    });
    expect(copy.kind).toBe('cancelled');
    expect(copy.action).toBeUndefined();
  });

  it('积分不足给出查看积分入口', () => {
    const copy = selectClientFailureCopy({
      presentation: { ...failedPresentation, summary: '组织积分余额不足' },
      severity: 'billing',
    });
    expect(copy.kind).toBe('billing');
    expect(copy.message).toBe('组织积分余额不足');
    expect(copy.action).toEqual({ kind: 'view_billing', label: '查看积分' });
  });

  it('已归类的传输失败直接消费 canonical 文案与动作', () => {
    const copy = selectClientFailureCopy({
      presentation: failedPresentation,
      canonicalFailure: mapCanonicalError({ status: 401 }),
    });
    expect(copy.kind).toBe('canonical');
    expect(copy.title).toBe('登录已过期');
    expect(copy.action).toEqual({ kind: 'relogin', label: '重新登录' });
  });
});

describe('formatQuotaResetHint', () => {
  it('按量级选择秒/分钟/小时，非法值不产出文案', () => {
    expect(formatQuotaResetHint(1_500)).toBe('额度将在 2 秒后重置');
    expect(formatQuotaResetHint(120_000)).toBe('额度将在 2 分钟后重置');
    expect(formatQuotaResetHint(7_200_000)).toBe('额度将在 2 小时后重置');
    expect(formatQuotaResetHint(0)).toBeUndefined();
    expect(formatQuotaResetHint(undefined)).toBeUndefined();
    expect(formatQuotaResetHint(Number.NaN)).toBeUndefined();
  });
});
