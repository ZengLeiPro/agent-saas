import { describe, expect, it } from "vitest";
import analysisContentSource from "@/components/AnalysisWorkspaceContent.tsx?raw";
import taskBoardSource from "@/components/TaskBoard/index.tsx?raw";
import taskDetailSource from "@/components/TaskBoard/TaskDetail.tsx?raw";
import source from "./DesktopLayout.tsx?raw";

describe("DesktopLayout 初始会话接线", () => {
  it("个人与企业专家都启用统一初始 composer", () => {
    expect(source).toContain("initialComposer={!isTrashPreview");
    expect(source).toContain("Boolean(activeOrgAgent) || personalAgentEnabled");
  });

  it("首日引导保持挂载监听事件，但只在个人 Agent 成功终态后显示", () => {
    expect(source).toContain("&& !activeOrgAgent");
    expect(source).toContain("visible={hasSuccessfulFinalOutput(messages)}");
  });

  it("分析路由复用标准浮动布局，不再进入旧 GovernanceConsole 壳", () => {
    expect(source).toContain("analysisMode={analysisMode}");
    expect(analysisContentSource).toContain('data-testid="unified-analysis-content"');
    expect(analysisContentSource).toContain("governanceContentEmbedded");
    expect(source).toContain('if (!analysisMode && activeTab === "platform-admin"');
    expect(source).toContain('if (!analysisMode && activeTab === "tenant-admin"');
  });

  it("能力中心与任务中心使用同一 Header 高度和水平位置", () => {
    expect(source).toContain('activeTab === "capabilities" || activeTab === "cron" ? "h-14 px-6"');
  });

  it("任务详情复用外层分栏，并保留任务详情与业务步骤各自默认宽度", () => {
    expect(source).toContain("const showDockedPanel = showRightPanel || showTaskDetailPanel");
    expect(source).toContain("style={showDockedPanel");
    expect(source).toContain("detailPanelTarget={taskDetailPanelTarget}");
    expect(source).toContain("onTaskDetailOpenChange={setTaskDetailOpen}");
    expect(source).toContain('label="调整任务详情宽度"');
    expect(source).toContain("const dockedPanelInitialRatio = showTaskDetailPanel");
    expect(source).toContain("? 0.46");
    expect(source).toContain('rightPanelKind === "business-step" ? 0.42 : 0.5');
    expect(source).toContain("useResizePanel(dockedPanelInitialRatio, 0.25, 0.75, dockedPanelKey)");
    expect(source).toContain('minWidth: "min(26rem, 75%)"');
    expect(taskBoardSource).toContain("portalTarget={detailPanelTarget}");
    expect(taskBoardSource).toContain("onDetailOpenChange?.(detailVisible)");
    expect(taskDetailSource).toContain("portalTarget ? createPortal(panel, portalTarget) : panel");
    expect(taskDetailSource).toContain('? "flex h-full min-h-0 w-full flex-col"');
  });

  it("个人、组织与平台设置共享 dirty boundary，并回传组织 Shell 实际目标", () => {
    expect(source).toContain('const SettingsDirtyBoundary = lazy(() => import("@/components/PersonalSettings/dirtyRegistry")');
    expect(source).toContain("{settingsMode && <Suspense fallback={SuspenseFallback}><SettingsDirtyBoundary>{(dirtyController) => (");
    expect(source).toContain("onNavigationControllerChange={handleSettingsControllerChange} dirtyController={dirtyController}");
    expect(source).toContain("isPlatformAdmin, organizationSettingsTargetId");
    expect(source).toContain("onSettingsTargetTenantIdChange={setOrganizationSettingsTargetId}");
    expect(source).toContain("onSettingsTargetTenantIdChange={setOrganizationSettingsTargetId} dirtyController={dirtyController}");
    expect(source).toContain(")}</SettingsDirtyBoundary></Suspense>}");
    expect(source).toContain('<GovernanceConsole area="platform" route={governanceRoute} onExit={() => setActiveTab("chat")} dirtyController={dirtyController}>');
    expect(source).toContain('<GovernanceConsole area="organization" route={governanceRoute} onExit={() => setActiveTab("chat")} dirtyController={dirtyController}>');
    expect(source).toContain('<SettingsDirtyBoundary>{(dirtyController) => (\n        <ManagementSettingsAccessGate scope="platform"');
    expect(source).toContain('<SettingsDirtyBoundary>{(dirtyController) => (\n        <ManagementSettingsAccessGate scope="tenant"');
    expect(analysisContentSource).toContain('<OrganizationScopeBanner route={route} dirtyController={dirtyController} />');
    expect(analysisContentSource).toContain('dirtyController={dirtyController}');
  });
});
