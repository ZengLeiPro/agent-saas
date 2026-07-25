/**
 * 效率视图天数继承的契约测试。
 *
 * 为什么值得测：用量页签的 RangeSelector 有 today/7d/30d/本月/全部/自定义六种，
 * 效率视图只有 7/14/30 三档。两套值域不同，改造前切页签会**静默丢掉**用户刚选的
 * 区间跳回 7 天——用户以为自己还在看 30 天的数据，据此得出的结论是错的。
 *
 * 这里锁两件事：折算方向（只向下取）与 cap 口径（效率后端上限 30 天）。
 */
import { describe, expect, it } from "vitest";

import { rangeToStatsWindow } from "@/components/TenantAnalytics/metrics";

import { nearestEffDays } from "./EfficiencyView";

const TODAY = "2026-07-25";

/** 复刻 UsageDashboard 里的继承计算，保证两边口径一致 */
function inherited(range: Parameters<typeof rangeToStatsWindow>[0], custom: { from: string; to: string } | null = null) {
  return nearestEffDays(rangeToStatsWindow(range, custom, 30, TODAY).days);
}

describe("nearestEffDays", () => {
  it("精确命中档位时原样返回", () => {
    expect(nearestEffDays(7)).toBe(7);
    expect(nearestEffDays(14)).toBe(14);
    expect(nearestEffDays(30)).toBe(30);
  });

  it("只向下取，不向上——窗口偏小比偏大安全", () => {
    // 用户要 10 天，给 14 天等于多给了他没要的数据
    expect(nearestEffDays(10)).toBe(7);
    expect(nearestEffDays(13)).toBe(7);
    expect(nearestEffDays(29)).toBe(14);
  });

  it("超出最大档位时收敛到 30，不会请求一年", () => {
    expect(nearestEffDays(90)).toBe(30);
    expect(nearestEffDays(365)).toBe(30);
  });

  it("小于最小档位时兜到 7，不会出现 0 天或负数", () => {
    expect(nearestEffDays(1)).toBe(7);
    expect(nearestEffDays(0)).toBe(7);
    expect(nearestEffDays(-5)).toBe(7);
  });
});

describe("用量页签时间窗 → 效率视图天数", () => {
  it("选 30 天，切页签后仍是 30 天（改造前会跳回 7 天）", () => {
    expect(inherited("30d")).toBe(30);
  });

  it("选「全部」时按效率后端上限 30 天折算", () => {
    // rangeToStatsWindow 对 all 返回 {days: cap, capped: true}
    const window = rangeToStatsWindow("all", null, 30, TODAY);
    expect(window.capped).toBe(true);
    expect(inherited("all")).toBe(30);
  });

  it("选今日/7 天落在最小档位", () => {
    expect(inherited("today")).toBe(7);
    expect(inherited("7d")).toBe(7);
  });

  it("本月至今按当天日期折算后向下取档", () => {
    // 7-25 → 25 天 → 向下取到 14
    expect(inherited("mtd")).toBe(14);
  });

  it("自定义区间同样向下取档，且不超过 30 天上限", () => {
    expect(inherited("custom", { from: "2026-07-18", to: "2026-07-25" })).toBe(7);
    expect(inherited("custom", { from: "2026-07-05", to: "2026-07-25" })).toBe(14);
    expect(inherited("custom", { from: "2026-01-01", to: "2026-07-25" })).toBe(30);
  });
});
