import { describe, expect, it } from "vitest";
import appSource from "@/App.tsx?raw";
import desktopSource from "./DesktopLayout.tsx?raw";
import mobileSource from "./MobileLayout.tsx?raw";

describe("任务看板执行会话只读接线", () => {
  it("按加载态和实际 owner 判定只读，未知详情默认锁定", () => {
    expect(appSource).toContain("isLoadingMessages || !sessionParticipants");
    expect(appSource).toContain("sessionParticipants.owner.userId !== authUser?.id");
    expect(appSource).toContain("activeOrgAgentReadOnly, sessionReadOnly");
  });

  it.each([
    ["桌面端", desktopSource],
    ["移动端", mobileSource],
  ])("%s 禁止跨用户会话交互并展示只读提示", (_name, source) => {
    expect(source).toContain("isTrashPreview || sessionReadOnly || activeOrgAgentReadOnly");
    expect(source).toContain("任务执行会话仅供协作成员查看");
    expect(source).toContain("!isTrashPreview && !sessionReadOnly");
  });
});
