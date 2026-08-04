import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INDUSTRY_ALL, matchIndustry, useIndustryFilter } from "./useIndustryFilter";

const mocked = vi.hoisted(() => ({
  user: null as { preferences?: { industryHint?: string } } | null,
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mocked.user }),
}));

const STORAGE_KEY = "ky.scenarios.industry";

function resetHistory() {
  window.history.replaceState({}, "", "/capabilities/templates");
}

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

describe("useIndustryFilter · URL 回写边界", () => {
  beforeEach(() => {
    mocked.user = null;
    localStorage.clear();
    resetHistory();
  });

  afterEach(() => {
    mocked.user = null;
    localStorage.clear();
    resetHistory();
  });

  it("默认（只读消费者）不把 storage 初值写进 URL", () => {
    localStorage.setItem(STORAGE_KEY, "trade");

    const { result } = renderHook(() => useIndustryFilter());

    // 过滤仍按本地偏好收窄
    expect(result.current.activeIndustry).toBe("trade");
    // 但 URL 保持干净：页面上没有行业 chip，用户无从理解也无从撤销
    expect(window.location.search).toBe("");
  });

  it("默认（只读消费者）不把 preferences.industryHint 写进 URL", () => {
    mocked.user = { preferences: { industryHint: "export" } };

    const { result } = renderHook(() => useIndustryFilter());

    expect(result.current.activeIndustry).toBe("export");
    expect(window.location.search).toBe("");
  });

  it("syncUrlOnMount=true（场景库整页）才把 storage 初值反写进 URL", () => {
    localStorage.setItem(STORAGE_KEY, "trade");

    const { result } = renderHook(() => useIndustryFilter({ syncUrlOnMount: true }));

    expect(result.current.activeIndustry).toBe("trade");
    expect(window.location.search).toBe("?industry=trade");
  });

  it("初值为 all 时任何调用方都不写 URL", () => {
    const { result } = renderHook(() => useIndustryFilter({ syncUrlOnMount: true }));

    expect(result.current.activeIndustry).toBe(INDUSTRY_ALL);
    expect(window.location.search).toBe("");
  });
});
