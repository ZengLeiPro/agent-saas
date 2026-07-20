import { describe, expect, it } from "vitest";
import { getSidebarNavItems } from "./sidebar";

describe("侧边栏一级导航", () => {
  it("个人 Agent 可用时按能力中心、定时任务排序", () => {
    expect(getSidebarNavItems({ isAdmin: false, personalAgentEnabled: true })).toMatchObject([
      { tab: "capabilities", label: "能力中心" },
      { tab: "cron", label: "定时任务" },
    ]);
  });

  it("关闭个人 Agent 时隐藏定时任务", () => {
    expect(getSidebarNavItems({ isAdmin: false, personalAgentEnabled: false }).map((item) => item.tab))
      .toEqual(["capabilities"]);
  });
});
