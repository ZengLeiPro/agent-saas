/**
 * 图表轴计算的契约测试。
 *
 * 这几个纯函数被 `UsageDashboard/TrendChart` 与 `TenantAnalytics/MiniBarTrend` 共用，
 * 一旦回归会让两处图表同时错位（柱子出界、刻度对不上网格线、90 天窗口柱宽算成 0）。
 */
import { describe, expect, it } from "vitest";

import { barWidth, buildYTicks, pickXLabelIndexes } from "./chartAxis";

describe("buildYTicks", () => {
  it("默认 4 段产生 5 条刻度，含 0 与 max", () => {
    const ticks = buildYTicks({ max: 100, innerHeight: 200, padTop: 0 });
    expect(ticks).toHaveLength(5);
    expect(ticks[0].value).toBe(0);
    expect(ticks.at(-1)?.value).toBe(100);
  });

  it("0 刻度在底部，max 刻度在顶部（SVG y 轴向下）", () => {
    const ticks = buildYTicks({ max: 100, innerHeight: 200, padTop: 10 });
    // value=0 → y = padTop + innerHeight
    expect(ticks[0].y).toBe(210);
    // value=max → y = padTop
    expect(ticks.at(-1)?.y).toBe(10);
  });

  it("刻度 y 严格递减，不会与网格线错位", () => {
    const ticks = buildYTicks({ max: 777, innerHeight: 160, padTop: 12 });
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].y).toBeLessThan(ticks[i - 1].y);
    }
  });

  it("max 为 0 或负数时兜到 1，不产生 NaN / Infinity", () => {
    for (const max of [0, -5, Number.NaN]) {
      const ticks = buildYTicks({ max, innerHeight: 100, padTop: 0 });
      expect(ticks.every((t) => Number.isFinite(t.y))).toBe(true);
    }
  });

  it("count 可调（卡片内小图用 2 段避免刻度糊成一片）", () => {
    expect(buildYTicks({ max: 10, innerHeight: 100, padTop: 0, count: 2 })).toHaveLength(3);
  });
});

describe("pickXLabelIndexes", () => {
  it("首尾必显示", () => {
    const picked = pickXLabelIndexes({ count: 30, innerWidth: 600 });
    expect(picked[0]).toBe(0);
    expect(picked.at(-1)).toBe(29);
  });

  it("返回值升序且无重复", () => {
    const picked = pickXLabelIndexes({ count: 90, innerWidth: 800 });
    expect([...new Set(picked)]).toEqual(picked);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
  });

  it("窄容器少标签，宽容器多标签", () => {
    const narrow = pickXLabelIndexes({ count: 30, innerWidth: 240 });
    const wide = pickXLabelIndexes({ count: 30, innerWidth: 1200 });
    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  it("标签数不超过数据点数", () => {
    const picked = pickXLabelIndexes({ count: 3, innerWidth: 2000 });
    expect(picked.length).toBeLessThanOrEqual(3);
    expect(Math.max(...picked)).toBeLessThan(3);
  });

  it("退化输入不炸：0 点返回空，1 点只返回下标 0", () => {
    expect(pickXLabelIndexes({ count: 0, innerWidth: 500 })).toEqual([]);
    expect(pickXLabelIndexes({ count: 1, innerWidth: 500 })).toEqual([0]);
  });
});

describe("barWidth", () => {
  it("按可用宽度均分并留出间隙", () => {
    // 10 根柱、300px、gap 2 → 30 - 2 = 28
    expect(barWidth({ innerWidth: 300, count: 10, gap: 2 })).toBe(28);
  });

  it("90 天窗口下仍至少 1px —— 否则整张图看起来是空的", () => {
    const w = barWidth({ innerWidth: 100, count: 90, gap: 2 });
    expect(w).toBeGreaterThanOrEqual(1);
  });

  it("count 为 0 时返回 0，不产生 Infinity", () => {
    expect(barWidth({ innerWidth: 300, count: 0 })).toBe(0);
  });
});
