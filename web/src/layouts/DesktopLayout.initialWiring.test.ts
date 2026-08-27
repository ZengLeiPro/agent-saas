import { describe, expect, it } from "vitest";
import analysisContentSource from "@/components/AnalysisWorkspaceContent.tsx?raw";
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

  it("个人、组织与平台设置共享 dirty boundary，并回传组织 Shell 实际目标", () => {
    expect(source).toContain('const SettingsDirtyBoundary = lazy(() => import("@/components/PersonalSettings/dirtyRegistry")');
    expect(source).toContain("{settingsMode && <Suspense fallback={SuspenseFallback}><SettingsDirtyBoundary>{(dirtyController) => (");
    expect(source).toContain("onNavigationControllerChange={handleSettingsControllerChange} dirtyController={dirtyController}");
    expect(source).toContain("isPlatformAdmin, organizationSettingsTargetId");
    expect(source).toContain("onSettingsTargetTenantIdChange={setOrganizationSettingsTargetId}");
    expect(source).toContain(")}</SettingsDirtyBoundary></Suspense>}");
  });
});
