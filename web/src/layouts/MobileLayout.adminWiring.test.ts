import { describe, expect, it } from "vitest";
import { managementAccessTarget } from "@/lib/managementAccessView";
import mobileSessionListSource from "@/components/MobileSessionList.tsx?raw";
import mobileSettingsModalSource from "@/components/SettingsCenter/MobileSettingsModal.tsx?raw";
import source from "./MobileLayout.tsx?raw";
import managementContentSource from '@/components/ManagementShell/ManagementWorkspaceContent.tsx?raw';

describe("MobileLayout 管理模块接线", () => {
  it("移动端只挂载一个统一管理工作区", () => {
    expect(source.match(/<ManagementWorkspaceContent\b/g)).toHaveLength(1);
    expect(source).not.toContain('<TenantAdminShell');
    expect(source).not.toContain('<PlatformAdminShell');
    expect(managementContentSource).toContain('renderOrgAgents=');
  });

  it("组织与平台治理入口接入统一 dirty boundary", () => {
    expect(managementContentSource).toContain('SettingsDirtyBoundary');
    expect(managementContentSource).toContain('ManagementSettingsAccessGate');
    expect(managementContentSource).toContain('governanceContentEmbedded');
    expect(source).not.toContain('<GovernanceConsole');
    expect(source).toContain('organizationTargetId={organizationSettingsTargetId.current}');
    expect(mobileSettingsModalSource).toContain('organizationTargetId,');
  });

  it("移动头像菜单通过唯一设置入口承载组织与平台管理", () => {
    expect(source).toContain("<MobileSettingsModal");
    expect(mobileSettingsModalSource).toContain("managementGroups={managementGroups}");
    expect(mobileSettingsModalSource).toContain("managementPagesFor('config', 'organization')");
    expect(mobileSettingsModalSource).toContain("managementPagesFor('config', 'platform')");
    expect(mobileSessionListSource).toContain("设置");
    expect(mobileSessionListSource).not.toContain("个人设置");
    expect(mobileSessionListSource).not.toContain("组织控制台");
    expect(mobileSessionListSource).not.toContain("平台控制台");
  });

  it("个人 Agent 移动端接入统一初始会话 composer", () => {
    expect(source).toContain("const chatEmptySlot = useMemo");
    expect(source).toContain("roleDetailId={roleDetailId}");
    expect(source).toContain(": chatEmptySlot))}");
    expect(source).toContain("initialComposer={!isTrashPreview");
  });

  it("首日引导保持挂载监听事件，但只在个人 Agent 成功终态后显示", () => {
    expect(source).toContain("&& !activeOrgAgent");
    expect(source).toContain("visible={hasSuccessfulFinalOutput(messages)}");
  });

  it("legacy 场景保留 scenario 上下文供首日引导判断 oneshot", () => {
    expect(source).toContain("(prompt: string, scenario?: ScenarioItem)");
    expect(source).toContain("setLastTriedScenario(scenario ?? null)");
    expect(source).toContain("activeScenario={lastTriedScenario ?? undefined}");
  });

  it.each([
    ["tenant settings deep link", false, "tenant", "chat", null, "tenant"],
    ["platform settings deep link", false, "platform", "chat", null, "platform"],
    ["organization canonical", false, null, "tenant-admin", "organization", "tenant"],
    ["platform canonical", false, null, "platform-admin", "platform", "platform"],
    ["personal settings", true, null, "chat", null, "personal"],
    ["ordinary chat", false, null, "chat", null, null],
  ] as const)("纯逻辑识别管理访问目标：%s", (
    _case, settingsOpen, adminSettingsTarget, activeTab, governanceArea, expected,
  ) => {
    expect(managementAccessTarget({ settingsOpen, adminSettingsTarget, activeTab, governanceArea })).toBe(expected);
  });
});
