import { describe, expect, it } from "vitest";
import { getSidebarNavItems } from "./sidebar";

describe("侧边栏一级导航", () => {
  it("个人 Agent 可用时按能力中心、任务中心排序", () => {
    expect(getSidebarNavItems({ isAdmin: false, personalAgentEnabled: true })).toMatchObject([
      { tab: "capabilities", label: "能力中心" },
      { tab: "cron", label: "任务中心" },
    ]);
  });

  it("关闭个人 Agent 时隐藏任务中心", () => {
    expect(getSidebarNavItems({ isAdmin: false, personalAgentEnabled: false }).map((item) => item.tab))
      .toEqual(["capabilities"]);
  });
});
