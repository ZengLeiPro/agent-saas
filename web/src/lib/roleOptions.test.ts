import { describe, expect, it } from "vitest";
import { ROLE_POSITION_OPTIONS } from "./roleOptions";

describe("ROLE_POSITION_OPTIONS", () => {
  it("与场景库岗位对齐，含关键岗位且顺序稳定", () => {
    expect(ROLE_POSITION_OPTIONS).toEqual([
      "老板/总经理",
      "销售",
      "跟单/客服",
      "采购",
      "财务",
      "人事行政",
      "市场/电商运营",
      "生产计划",
    ]);
  });

  it("无重复项", () => {
    expect(new Set(ROLE_POSITION_OPTIONS).size).toBe(ROLE_POSITION_OPTIONS.length);
  });
});
