import { describe, expect, it } from "vitest";
import managementContentSource from "@/components/ManagementShell/ManagementWorkspaceContent.tsx?raw";
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

  it("分析与设置路由复用唯一管理工作区，不再进入旧治理壳", () => {
    expect(source).toContain("analysisMode={analysisMode}");
    expect(source.match(/<ManagementWorkspaceContent\b/g)).toHaveLength(1);
    expect(managementContentSource).toContain('data-testid="unified-management-content"');
    expect(managementContentSource).toContain("governanceContentEmbedded");
    expect(source).not.toContain('<GovernanceConsole');
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
    expect(source).toContain("useDesktopLayoutProtection");
    expect(source).toContain('responsiveMode={responsiveSidebarMode}');
    expect(source).toContain('responsiveSidebarOverlayOpen && "absolute inset-y-0 left-0 z-50 shadow-2xl"');
    expect(source).toContain('aria-label="关闭临时侧边栏"');
    expect(source).toContain('ref={layoutProtection.fontProbeRef}');
    expect(source).toContain('width: `min(${dockedPanelWidth}, calc(100% - 1rem))`');
    expect(source.match(/style=\{responsivePanelStyle\}/g)).toHaveLength(2);
    expect(source.match(/data-responsive-panel-mode=/g)).toHaveLength(2);
    expect(source).not.toContain("dockedPanelInitialRatio");
    expect(taskBoardSource).toContain("portalTarget={detailPanelTarget}");
    expect(taskBoardSource).toContain("onDetailOpenChange?.(detailVisible)");
    expect(taskDetailSource).toContain("portalTarget ? createPortal(panel, portalTarget) : panel");
    expect(taskDetailSource).toContain('? "flex h-full min-h-0 w-full flex-col"');
  });

  it("个人设置与统一管理工作区共享 dirty boundary", () => {
    expect(source).toContain("SettingsDirtyBoundary");
    expect(lazySettingsSource).toContain("export const SettingsDirtyBoundary = lazy(() =>");
    expect(lazySettingsSource).toContain("@/components/PersonalSettings/dirtyRegistry");
    expect(source).toContain("settingsTarget === 'personal'");
    expect(source).toContain("dirtyController={dirtyController}");
    expect(source).toContain("governanceRoute, closeOrganizationSettings: closeSettings,");
    expect(source).not.toContain("SettingsDirtyControllerBridge");
    expect(source).toContain(")}</SettingsDirtyBoundary></Suspense>}");
    expect(managementContentSource).toContain('<SettingsDirtyBoundary>');
    expect(managementContentSource).toContain('{(dirtyController) => (');
    expect(managementContentSource).toContain('dirtyController={dirtyController}');
  });

  it("进入统一设置后隐藏底层业务页，避免旧组织分析与新组织管理重复可访问", () => {
    expect(source).toContain('className={cn("contents", settingsMode && "invisible")}');
    expect(source).toContain("aria-hidden={settingsMode || undefined}");
    expect(source).not.toContain('(settingsMode || activeTab !== "chat") && "hidden"');
  });
});
