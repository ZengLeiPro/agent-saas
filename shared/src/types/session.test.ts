import { describe, expect, it } from "vitest";
import { formatTokenCount } from "./session";

describe("formatTokenCount", () => {
  it.each([
    [999, "999"],
    [1_234, "1.2k"],
    [1_234_567, "1.2M"],
    [1_000_000_000, "1.0B"],
    [1_234_567_890, "1.2B"],
  ])("将 %i 格式化为 %s", (count, expected) => {
    expect(formatTokenCount(count)).toBe(expected);
  });
});
