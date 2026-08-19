import { describe, expect, it } from "vitest";
import source from "./MobileLayout.tsx?raw";

describe("MobileLayout 管理模块接线", () => {
  it("每个组织管理壳实例都接入组织智能体模块", () => {
    const shellCount = source.match(/<TenantAdminShell\b/g)?.length ?? 0;
    const orgAgentRendererCount = source.match(/renderOrgAgents=/g)?.length ?? 0;

    expect(shellCount).toBeGreaterThan(0);
    expect(orgAgentRendererCount).toBe(shellCount);
  });

  it("个人 Agent 移动端接入统一初始会话 composer 与岗位详情", () => {
    expect(source).toContain("const chatEmptySlot = useMemo");
    expect(source).toContain("onOpenRoleDetail={handleOpenRoleDetail}");
    expect(source).toContain("roleDetailId={roleDetailId}");
    expect(source).toContain(": chatEmptySlot))}");
    expect(source).toContain("initialComposer={!isTrashPreview");
  });

  it("首日引导保持挂载监听事件，但只在个人 Agent 完整回复后显示", () => {
    expect(source).toContain("&& !activeOrgAgent");
    expect(source).toContain('visible={messages.some((message) => message.type === "text" && message.streaming !== true)}');
  });
});
