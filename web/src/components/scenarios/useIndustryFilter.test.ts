import { describe, expect, it } from "vitest";

import { INDUSTRY_ALL, matchIndustry } from "./useIndustryFilter";

describe("matchIndustry", () => {
  it("passes any scenario when active is 'all'", () => {
    expect(matchIndustry(undefined, INDUSTRY_ALL)).toBe(true);
    expect(matchIndustry([], INDUSTRY_ALL)).toBe(true);
    expect(matchIndustry(["retail"], INDUSTRY_ALL)).toBe(true);
    expect(matchIndustry(["manufacturing"], INDUSTRY_ALL)).toBe(true);
  });

  it("treats undefined industryFocus as universally applicable", () => {
    expect(matchIndustry(undefined, "retail")).toBe(true);
    expect(matchIndustry(undefined, "manufacturing")).toBe(true);
  });

  it("treats empty industryFocus array the same as undefined", () => {
    expect(matchIndustry([], "retail")).toBe(true);
  });

  it("matches when active industry is contained in industryFocus", () => {
    expect(matchIndustry(["retail"], "retail")).toBe(true);
    expect(matchIndustry(["retail", "ecommerce"], "ecommerce")).toBe(true);
  });

  it("drops scenarios whose industryFocus does not include active industry", () => {
    expect(matchIndustry(["manufacturing"], "retail")).toBe(false);
    expect(matchIndustry(["export", "trade"], "retail")).toBe(false);
  });
});
