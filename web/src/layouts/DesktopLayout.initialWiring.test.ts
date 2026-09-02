import { describe, expect, it } from "vitest";
import analysisContentSource from "@/components/AnalysisWorkspaceContent.tsx?raw";
import taskBoardSource from "@/components/TaskBoard/index.tsx?raw";
import taskDetailSource from "@/components/TaskBoard/TaskDetail.tsx?raw";
import source from "./DesktopLayout.tsx?raw";
import lazySettingsSource from "./lazySettingsComponents.ts?raw";

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
    expect(source).not.toContain('<GovernanceConsole area="organization"');
  });

  it("能力中心与任务中心使用同一 Header 高度和水平位置", () => {
    expect(source).toContain('activeTab === "capabilities" || activeTab === "cron" ? "h-14 px-6"');
  });

  it("任务详情复用外层分栏，并与正式会话统一响应式默认宽度", () => {
    expect(source).toContain("const showDockedPanel = showRightPanel || showTaskDetailPanel");
    expect(source).toContain("style={{ flex: 1 }}");
    expect(source).toContain("detailPanelTarget={taskDetailPanelTarget}");
    expect(source).toContain("onTaskDetailOpenChange={setTaskDetailOpen}");
    expect(source).toContain('label="调整任务详情宽度"');
    expect(source).toContain("useResizePanel(0.35, 0.25, 0.75, dockedPanelKey)");
    expect(source).toContain('const dockedPanelWidth = `clamp(26rem, ${splitRatio * 100}%, 46rem)`');
    expect(source.match(/style=\{\{ width: dockedPanelWidth, flexShrink: 0 \}\}/g)).toHaveLength(2);
    expect(source).not.toContain("dockedPanelInitialRatio");
    expect(taskBoardSource).toContain("portalTarget={detailPanelTarget}");
    expect(taskBoardSource).toContain("onDetailOpenChange?.(detailVisible)");
    expect(taskDetailSource).toContain("portalTarget ? createPortal(panel, portalTarget) : panel");
    expect(taskDetailSource).toContain('? "flex h-full min-h-0 w-full flex-col"');
  });

  it("个人、组织与平台设置共享 dirty boundary，并回传组织 Shell 实际目标", () => {
    expect(source).toContain("SettingsDirtyBoundary");
    expect(lazySettingsSource).toContain('export const SettingsDirtyBoundary = lazy(() => import("@/components/PersonalSettings/dirtyRegistry")');
    expect(source).toContain("{settingsMode && <Suspense fallback={SuspenseFallback}><SettingsDirtyBoundary onControllerChange={handleSettingsControllerChange}>{(dirtyController) => (");
    expect(source).toContain("dirtyController={dirtyController}");
    expect(source).toContain("isPlatformAdmin, organizationSettingsTargetId");
    expect(source).toContain("onSettingsTargetTenantIdChange={setOrganizationSettingsTargetId}");
    expect(source).toContain("onSettingsTargetTenantIdChange={setOrganizationSettingsTargetId} dirtyController={dirtyController}");
    expect(source).toContain("governanceRoute, closeOrganizationSettings: closeSettings,");
    expect(source).toContain("governanceContentOnly={governanceRoute?.area === \"organization\"}");
    expect(source).not.toContain("SettingsDirtyControllerBridge");
    expect(source).toContain(")}</SettingsDirtyBoundary></Suspense>}");
    expect(source).toContain('<GovernanceConsole area="platform" route={governanceRoute} onExit={() => setActiveTab("chat")} dirtyController={dirtyController}>');
    expect(source).not.toContain('<GovernanceConsole area="organization" route={governanceRoute} onExit={() => setActiveTab("chat")} dirtyController={dirtyController}>');
    expect(source).toContain('<SettingsDirtyBoundary>{(dirtyController) => (\n        <ManagementSettingsAccessGate scope="platform"');
    expect(analysisContentSource).toContain('<OrganizationScopeBanner route={route} dirtyController={dirtyController} />');
    expect(analysisContentSource).toContain('dirtyController={dirtyController}');
  });

  it("进入统一设置后隐藏底层业务页，避免旧组织分析与新组织管理重复可访问", () => {
    expect(source).toContain('className={cn("contents", settingsMode && "invisible")}');
    expect(source).toContain("aria-hidden={settingsMode || undefined}");
    expect(source).not.toContain('(settingsMode || activeTab !== "chat") && "hidden"');
  });
});
