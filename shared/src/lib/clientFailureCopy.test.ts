import { describe, expect, it } from 'vitest';

import {
  GENERIC_FAILURE_MESSAGE,
  POLICY_FAILURE_MESSAGE,
  formatQuotaResetClock,
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

describe('配额耗尽文案（quota_exhausted + resetAt）', () => {
  function clockOf(offsetMs: number): { iso: string; hhmm: string } {
    const at = new Date(Date.now() + offsetMs);
    return {
      iso: at.toISOString(),
      hhmm: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
    };
  }

  it('formatQuotaResetClock：按设备时区输出 HH:mm，无效/过期返回 undefined', () => {
    const { iso, hhmm } = clockOf(2 * 3600_000);
    expect(formatQuotaResetClock(iso)).toBe(hhmm);
    expect(formatQuotaResetClock(new Date(Date.now() - 60_000).toISOString())).toBeUndefined();
    expect(formatQuotaResetClock('nope')).toBeUndefined();
    expect(formatQuotaResetClock(undefined)).toBeUndefined();
  });

  it('resetAt 优先输出绝对时刻，且恢复动作是「切换模型」而不是「继续」', () => {
    const { iso, hhmm } = clockOf(3 * 3600_000);
    const copy = selectClientFailureCopy({
      presentation: failedPresentation,
      failureKind: 'quota_exhausted',
      recoveryAction: 'switch_model',
      resetAt: iso,
    });
    expect(copy.kind).toBe('quota');
    expect(copy.hint).toBe(`额度将在 ${hhmm} 重置`);
    // 绝不给「发送『继续』」这条在窗口重置前必然再失败的建议
    expect(copy.message).not.toBe(GENERIC_FAILURE_MESSAGE);
    expect(copy.message).not.toContain('发送');
    expect(copy.action).toEqual({ kind: 'switch_model', label: '切换模型' });
  });

  it('配额判定优先于策略判定：同带 switch_model 时不会被误归为 policy', () => {
    const copy = selectClientFailureCopy({
      presentation: {
        ...failedPresentation,
        recoveryAction: { kind: 'switch_model' as const, label: '切换模型' },
      },
      canonicalFailure: mapCanonicalError({ code: 'usage_limit_reached' }),
    });
    expect(copy.kind).toBe('quota');
    expect(copy.message).not.toBe(POLICY_FAILURE_MESSAGE);
  });

  it('拿不到 resetAt 时回落现有相对倒计时；两者都没有则只给结论', () => {
    const relative = selectClientFailureCopy({
      presentation: failedPresentation,
      canonicalFailure: mapCanonicalError({ code: 'usage_limit_reached', retryAfterMs: 90 * 60_000 }),
    });
    expect(relative.hint).toBe(formatQuotaResetHint(90 * 60_000));

    const bare = selectClientFailureCopy({
      presentation: failedPresentation,
      failureKind: 'quota_exhausted',
    });
    expect(bare.kind).toBe('quota');
    expect(bare.hint).toBeUndefined();
    expect(bare.action).toEqual({ kind: 'switch_model', label: '切换模型' });
  });

  it('普通限流（rate_limited 兜底）同样能吃 resetAt，行为不回退', () => {
    const { iso, hhmm } = clockOf(45 * 60_000);
    const copy = selectClientFailureCopy({
      presentation: failedPresentation,
      canonicalFailure: mapCanonicalError({ status: 429, resetAt: iso }),
    });
    expect(copy.kind).toBe('quota');
    expect(copy.hint).toBe(`额度将在 ${hhmm} 重置`);
  });
});
