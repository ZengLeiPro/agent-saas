/**
 * cronWizard.ts (zod) 测试
 *
 * 四个 step schema + submit/response schema：
 * - 合法输入 parse 成功
 * - 非法输入 safeParse 失败并检查 error path/约束边界
 * - step3 的 discriminatedUnion（humanReviewRequired true/false 两支）
 */
import { describe, expect, it } from 'vitest';
import {
  cronWizardStep1Schema,
  cronWizardStep2Schema,
  cronWizardStep3Schema,
  cronWizardSubmitSchema,
  cronWizardResponseSchema,
} from './cronWizard';

describe('cronWizardStep1Schema', () => {
  it('1~10 个非空监测对象合法', () => {
    expect(cronWizardStep1Schema.safeParse({ monitorTargets: ['竞品A', '竞品B'] }).success).toBe(true);
  });

  it('空数组失败（至少 1 个），path 指向 monitorTargets', () => {
    const r = cronWizardStep1Schema.safeParse({ monitorTargets: [] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['monitorTargets']);
  });

  it('超过 10 个失败', () => {
    const many = Array.from({ length: 11 }, (_, i) => `t${i}`);
    expect(cronWizardStep1Schema.safeParse({ monitorTargets: many }).success).toBe(false);
  });

  it('元素为空串失败（min(1)）', () => {
    const r = cronWizardStep1Schema.safeParse({ monitorTargets: [''] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['monitorTargets', 0]);
  });
});

describe('cronWizardStep2Schema', () => {
  it('合法信号自适配配置 parse 成功', () => {
    const parsed = cronWizardStep2Schema.parse({
      dailyEmptyStreakToWeekly: 3,
      userNoOpenStreakToPause: 7,
      emptyContentFallback: '本期无新增',
    });
    expect(parsed.dailyEmptyStreakToWeekly).toBe(3);
  });

  it('dailyEmptyStreakToWeekly 越界（>14）失败', () => {
    const r = cronWizardStep2Schema.safeParse({
      dailyEmptyStreakToWeekly: 15,
      userNoOpenStreakToPause: 7,
      emptyContentFallback: 'x',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['dailyEmptyStreakToWeekly']);
  });

  it('非整数失败', () => {
    const r = cronWizardStep2Schema.safeParse({
      dailyEmptyStreakToWeekly: 3.5,
      userNoOpenStreakToPause: 7,
      emptyContentFallback: 'x',
    });
    expect(r.success).toBe(false);
  });

  it('emptyContentFallback 为空串失败', () => {
    const r = cronWizardStep2Schema.safeParse({
      dailyEmptyStreakToWeekly: 3,
      userNoOpenStreakToPause: 7,
      emptyContentFallback: '',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['emptyContentFallback']);
  });
});

describe('cronWizardStep3Schema (discriminatedUnion)', () => {
  it('humanReviewRequired=false 时 target/channel 可自由取枚举值', () => {
    const r = cronWizardStep3Schema.safeParse({
      humanReviewRequired: false,
      target: 'group',
      channel: 'ding_group',
    });
    expect(r.success).toBe(true);
  });

  it('humanReviewRequired=false 时非法 target 枚举失败', () => {
    const r = cronWizardStep3Schema.safeParse({
      humanReviewRequired: false,
      target: 'nobody',
      channel: 'ding_group',
    });
    expect(r.success).toBe(false);
  });

  it('humanReviewRequired=true 时 target 必须为 manager、channel 必须为 ding_work_notification', () => {
    expect(cronWizardStep3Schema.safeParse({
      humanReviewRequired: true,
      target: 'manager',
      channel: 'ding_work_notification',
    }).success).toBe(true);

    // true 分支下 target=self 违反 literal("manager")
    expect(cronWizardStep3Schema.safeParse({
      humanReviewRequired: true,
      target: 'self',
      channel: 'ding_work_notification',
    }).success).toBe(false);
  });

  it('缺少判别字段 humanReviewRequired 失败', () => {
    const r = cronWizardStep3Schema.safeParse({ target: 'self', channel: 'ding_group' });
    expect(r.success).toBe(false);
  });
});

describe('cronWizardSubmitSchema', () => {
  it('完整合法提交体 parse 成功', () => {
    const r = cronWizardSubmitSchema.safeParse({
      scenarioId: 'sc-1',
      monitorTargets: ['竞品A'],
      signalAdaptation: {
        dailyEmptyStreakToWeekly: 3,
        userNoOpenStreakToPause: 7,
        emptyContentFallback: 'none',
      },
      pushSlot: { humanReviewRequired: false, target: 'self', channel: 'ding_group' },
    });
    expect(r.success).toBe(true);
  });

  it('scenarioId 为空串失败，path 指向 scenarioId', () => {
    const r = cronWizardSubmitSchema.safeParse({
      scenarioId: '',
      monitorTargets: ['x'],
      signalAdaptation: { dailyEmptyStreakToWeekly: 1, userNoOpenStreakToPause: 1, emptyContentFallback: 'x' },
      pushSlot: { humanReviewRequired: false, target: 'self', channel: 'ding_group' },
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['scenarioId']);
  });
});

describe('cronWizardResponseSchema', () => {
  it('runOnceError 可选，缺省时仍合法', () => {
    const r = cronWizardResponseSchema.safeParse({
      cronJobId: 'job-1',
      scenarioId: 'sc-1',
      createdAt: '2026-07-18',
      runOnceImmediately: true,
    });
    expect(r.success).toBe(true);
  });

  it('runOnceImmediately 缺失失败', () => {
    const r = cronWizardResponseSchema.safeParse({
      cronJobId: 'job-1',
      scenarioId: 'sc-1',
      createdAt: '2026-07-18',
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].path).toEqual(['runOnceImmediately']);
  });
});
