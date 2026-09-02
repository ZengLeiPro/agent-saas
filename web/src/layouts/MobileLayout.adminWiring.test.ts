import { describe, expect, it } from "vitest";
import { managementAccessTarget } from "@/lib/managementAccessView";
import mobileSessionListSource from "@/components/MobileSessionList.tsx?raw";
import mobileSettingsModalSource from "@/components/SettingsCenter/MobileSettingsModal.tsx?raw";
import source from "./MobileLayout.tsx?raw";
import lazySettingsSource from "./lazySettingsComponents.ts?raw";

describe("MobileLayout 管理模块接线", () => {
  it("每个组织管理壳实例都接入组织智能体模块", () => {
    const shellCount = source.match(/<TenantAdminShell\b/g)?.length ?? 0;
    const orgAgentRendererCount = source.match(/renderOrgAgents=/g)?.length ?? 0;

    expect(shellCount).toBeGreaterThan(0);
    expect(orgAgentRendererCount).toBe(shellCount);
  });

  it("组织与平台治理入口接入统一 dirty boundary", () => {
    expect(source).toContain("SettingsDirtyBoundary");
    expect(lazySettingsSource).toContain("export const SettingsDirtyBoundary = lazy(() =>");
    expect(lazySettingsSource).toContain("@/components/PersonalSettings/dirtyRegistry");
    expect(source).toContain('<GovernanceConsole area="platform" route={governanceRoute} onExit={() => setActiveTab("chat")} dirtyController={dirtyController}>');
    expect(source).not.toContain('<GovernanceConsole area="organization"');
    expect(source).toContain('data-testid="mobile-organization-settings"');
    expect(source).toContain('governanceContentEmbedded');
    expect(source).toContain('<SettingsDirtyBoundary>{(dirtyController) => (\n        <ManagementSettingsAccessGate\n          scope="platform"');
    expect(source).toContain('<SettingsDirtyBoundary>{(dirtyController) => (\n        <ManagementSettingsAccessGate\n          scope="tenant"');
    expect(source).toContain('<SettingsDirtyBoundary>{(dirtyController) => (<>\n        {adminSettings?.target === "tenant"');
    expect(source).toContain('dirtyController={dirtyController}\n            settingsSection={adminSettings.section as TenantSection}');
    expect(source).toContain('onSettingsClose={() => dirtyController.requestNavigation(closeAdminSettings)}');
    expect(source).toContain('dirtyController.requestNavigation(returnToSettingsMenu)');
    expect(source).toContain('dirtyController.requestNavigation(closeSettings)');
    expect(source).toContain('organizationTargetId={organizationSettingsTargetId.current}');
    expect(mobileSettingsModalSource).toContain('organizationTargetId,');
  });

  it("移动头像菜单通过唯一设置入口承载组织与平台管理", () => {
    expect(source).toContain("<MobileSettingsModal");
    expect(mobileSettingsModalSource).toContain("managementGroups={managementGroups}");
    expect(mobileSettingsModalSource).toContain("ORGANIZATION_SETTINGS_WORKSPACES.map");
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
