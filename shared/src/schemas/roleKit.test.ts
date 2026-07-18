/**
 * roleKit.ts (zod) 测试
 *
 * 覆盖关键 schema 与 refine 逻辑：
 * - scenarioItemSchema 的 superRefine：recurring 场景缺 signalAdaptation / pushSlot 时报错
 * - oneshot 场景无需 signalAdaptation/pushSlot
 * - roleWelcomeMessage 的 union（字符串 | 分支对象）
 * - salesPitch / demoShareToken / retentionPath7Day 等约束
 * - scenarioLibraryFileSchema 顶层结构（version、updatedAt 日期正则）
 */
import { describe, expect, it } from 'vitest';
import {
  scenarioItemSchema,
  scenarioRoleSchema,
  roleWelcomeMessageSchema,
  salesPitchSchema,
  demoShareTokenSchema,
  scenarioLibraryFileSchema,
  signalAdaptationSchema,
  pushSlotSchema,
} from './roleKit';

/** 构造一个满足基础必填字段的 oneshot 场景 */
function baseScenario(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sc-1',
    title: '示例场景',
    role: 'sales',
    industries: ['manufacturing'],
    mode: 'oneshot',
    pitch: '一句话卖点',
    story: '背景故事',
    promptTemplate: '模板 {slot}',
    slots: [],
    requires: ['web'],
    recommendCron: false,
    ...overrides,
  };
}

const validSignal = {
  dailyEmptyStreakToWeekly: 3,
  userNoOpenStreakToPause: 7,
  emptyContentFallback: '本期无新增',
};
const validPushSlot = { channel: 'ding_group', target: 'self', humanReviewRequired: false };

describe('scenarioItemSchema.superRefine', () => {
  it('oneshot 场景无需 signalAdaptation/pushSlot 也合法', () => {
    expect(scenarioItemSchema.safeParse(baseScenario()).success).toBe(true);
  });

  it('recurring 场景缺 signalAdaptation 报错，path 指向 signalAdaptation', () => {
    const r = scenarioItemSchema.safeParse(baseScenario({ mode: 'recurring', pushSlot: validPushSlot }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map(i => i.path.join('.'));
      expect(paths).toContain('signalAdaptation');
    }
  });

  it('recurring 场景缺 pushSlot 报错，path 指向 pushSlot', () => {
    const r = scenarioItemSchema.safeParse(baseScenario({ mode: 'recurring', signalAdaptation: validSignal }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map(i => i.path.join('.'));
      expect(paths).toContain('pushSlot');
    }
  });

  it('recurring 场景同时提供 signalAdaptation + pushSlot 合法', () => {
    const r = scenarioItemSchema.safeParse(baseScenario({
      mode: 'recurring',
      signalAdaptation: validSignal,
      pushSlot: validPushSlot,
    }));
    expect(r.success).toBe(true);
  });

  it('必填字段缺失（如 title）直接失败', () => {
    const { title, ...rest } = baseScenario();
    void title;
    expect(scenarioItemSchema.safeParse(rest).success).toBe(false);
  });

  it('非法枚举 mode 失败', () => {
    expect(scenarioItemSchema.safeParse(baseScenario({ mode: 'unknown_mode' })).success).toBe(false);
  });
});

describe('roleWelcomeMessageSchema (union)', () => {
  it('接受纯字符串', () => {
    expect(roleWelcomeMessageSchema.safeParse('欢迎使用').success).toBe(true);
  });

  it('接受分支对象（default/internal/export 可选）', () => {
    expect(roleWelcomeMessageSchema.safeParse({ default: '通用欢迎', export: '外贸欢迎' }).success).toBe(true);
  });

  it('拒绝空字符串', () => {
    expect(roleWelcomeMessageSchema.safeParse('').success).toBe(false);
  });
});

describe('signalAdaptationSchema / pushSlotSchema', () => {
  it('signalAdaptation 数值越界失败', () => {
    expect(signalAdaptationSchema.safeParse({ ...validSignal, userNoOpenStreakToPause: 31 }).success).toBe(false);
  });

  it('pushSlot 非法 channel 枚举失败', () => {
    expect(pushSlotSchema.safeParse({ ...validPushSlot, channel: 'email' }).success).toBe(false);
  });
});

describe('salesPitchSchema', () => {
  it('合法销售话术 parse 成功', () => {
    expect(salesPitchSchema.safeParse({
      oralScript: '口播稿',
      demoSteps: ['第一步'],
      bossQnA: [{ q: '多少钱', a: '按坐席' }],
    }).success).toBe(true);
  });

  it('demoSteps 为空数组失败（min 1）', () => {
    const r = salesPitchSchema.safeParse({
      oralScript: '稿',
      demoSteps: [],
      bossQnA: [{ q: 'q', a: 'a' }],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map(i => i.path.join('.'))).toContain('demoSteps');
  });

  it('oralScript 超长（>800）失败', () => {
    expect(salesPitchSchema.safeParse({
      oralScript: 'x'.repeat(801),
      demoSteps: ['s'],
      bossQnA: [{ q: 'q', a: 'a' }],
    }).success).toBe(false);
  });
});

describe('demoShareTokenSchema', () => {
  it('16~128 位字母数字下划线连字符合法', () => {
    expect(demoShareTokenSchema.safeParse('a1B2c3D4e5F6g7H8').success).toBe(true);
  });

  it('过短（<16）失败', () => {
    expect(demoShareTokenSchema.safeParse('short').success).toBe(false);
  });

  it('含非法字符（空格）失败', () => {
    expect(demoShareTokenSchema.safeParse('has space in token here').success).toBe(false);
  });
});

describe('scenarioRoleSchema', () => {
  it('roleTopPains 必须恰好 5 条', () => {
    const withFour = { id: 'r1', name: '角色', sort: 0, roleTopPains: ['a', 'b', 'c', 'd'] };
    expect(scenarioRoleSchema.safeParse(withFour).success).toBe(false);

    const withFive = { id: 'r1', name: '角色', sort: 0, roleTopPains: ['a', 'b', 'c', 'd', 'e'] };
    expect(scenarioRoleSchema.safeParse(withFive).success).toBe(true);
  });

  it('sort 为负数失败（min 0）', () => {
    expect(scenarioRoleSchema.safeParse({ id: 'r1', name: '角色', sort: -1 }).success).toBe(false);
  });
});

describe('scenarioLibraryFileSchema', () => {
  it('合法库文件（version=2, updatedAt 日期格式）parse 成功', () => {
    const r = scenarioLibraryFileSchema.safeParse({
      version: 2,
      updatedAt: '2026-07-18',
      roles: [{ id: 'r1', name: '角色', sort: 0 }],
      scenarios: [baseScenario()],
    });
    expect(r.success).toBe(true);
  });

  it('version 非 1/2 字面量失败', () => {
    expect(scenarioLibraryFileSchema.safeParse({
      version: 3,
      updatedAt: '2026-07-18',
      roles: [{ id: 'r1', name: '角色', sort: 0 }],
      scenarios: [baseScenario()],
    }).success).toBe(false);
  });

  it('updatedAt 非 YYYY-MM-DD 格式失败', () => {
    const r = scenarioLibraryFileSchema.safeParse({
      version: 1,
      updatedAt: '2026/07/18',
      roles: [{ id: 'r1', name: '角色', sort: 0 }],
      scenarios: [baseScenario()],
    });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map(i => i.path.join('.'))).toContain('updatedAt');
  });

  it('scenarios 为空数组失败（min 1）', () => {
    expect(scenarioLibraryFileSchema.safeParse({
      version: 1,
      updatedAt: '2026-07-18',
      roles: [{ id: 'r1', name: '角色', sort: 0 }],
      scenarios: [],
    }).success).toBe(false);
  });
});
