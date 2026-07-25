/**
 * 时间线相对偏移的格式契约（S5-B）。
 *
 * 两条不许回退的约定：
 *  1. 空值 / 非法值一律 "—"（全站空值统一符号，是我们对标下明确更好的地方）；
 *  2. 偏移是**相对起点**的紧凑等宽形态，绝对时刻不丢——由调用点放进 title。
 */
import { describe, expect, it } from "vitest";

import { diffMs, formatOffset } from "./format";

describe("formatOffset", () => {
  it("秒级保留两位小数，与 waterfall 横轴同形态", () => {
    expect(formatOffset(0)).toBe("+0.00s");
    expect(formatOffset(1234)).toBe("+1.23s");
    expect(formatOffset(13_810)).toBe("+13.81s");
    expect(formatOffset(59_999)).toBe("+60.00s");
  });

  it("分钟 / 小时级进位，秒与分补零保证纵向可扫读", () => {
    expect(formatOffset(60_000)).toBe("+1m00s");
    expect(formatOffset(184_000)).toBe("+3m04s");
    expect(formatOffset(3_600_000)).toBe("+1h00m");
    expect(formatOffset(3_720_000)).toBe("+1h02m");
  });

  it("空值 / 非法值 / 负偏移一律 —（不编造 +0.00s）", () => {
    expect(formatOffset(null)).toBe("—");
    expect(formatOffset(undefined)).toBe("—");
    expect(formatOffset(Number.NaN)).toBe("—");
    expect(formatOffset(-1)).toBe("—");
  });
});

describe("diffMs", () => {
  it("两个 ISO 时间戳之差", () => {
    expect(diffMs("2026-07-25T00:00:02.500Z", "2026-07-25T00:00:00.000Z")).toBe(2500);
    expect(diffMs("2026-07-25T00:00:00.000Z", "2026-07-25T00:00:02.500Z")).toBe(-2500);
  });

  it("任一侧缺失或非法 → null（调用点据此退回绝对时刻）", () => {
    expect(diffMs(undefined, "2026-07-25T00:00:00.000Z")).toBeNull();
    expect(diffMs("2026-07-25T00:00:00.000Z", null)).toBeNull();
    expect(diffMs("not-a-date", "2026-07-25T00:00:00.000Z")).toBeNull();
  });
});
