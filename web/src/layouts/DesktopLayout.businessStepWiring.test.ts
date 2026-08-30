import { describe, expect, it } from "vitest";
import source from "./DesktopLayout.tsx?raw";
import controllerSource from "./useChatRightPanelController.ts?raw";


describe("DesktopLayout 业务步骤与显式右栏接线", () => {
  it("与任务详情共享 dock 时仍保留独立 kind、稳定 key 与约 42% 默认宽度", () => {
    expect(controllerSource).toContain("rightPanelKind === 'business-step'");
    expect(controllerSource).toContain("? 'business-step'");
    expect(source).toContain('!showTaskDetailPanel && rightPanelKind === "business-step" ? 0.42 : 0.5');
    expect(source).toContain('showTaskDetailPanel ? "task-detail" : rightPanelKey');
    expect(source).toContain("useResizePanel(initialDockedPanelRatio, 0.25, 0.75, dockedPanelKey)");
    expect(source).toContain("data-business-step-detail-host");
  });

  it("ChatTabContent 受控接入右栏 host，不把 selected step id 当 reset key", () => {
    expect(source).toContain('businessStepDetailMode="desktop"');
    expect(source).toContain("businessStepDetailHost={businessStepDetailHost}");
    expect(source).toContain("businessStepPanelOpen={businessStepPanelOpen}");
    expect(source).not.toContain("rightPanelKey = selectedBusinessStep");
    expect(controllerSource).not.toContain("selectedBusinessStep");
  });

  it("只有 side 文件预览占用右栏，dialog 预览保留其后的步骤详情", () => {
    expect(controllerSource).toContain("if (options?.mode === 'side')");
    expect(controllerSource).not.toContain("options?.mode !== 'dialog'");
    expect(controllerSource).toContain("setIntent('preview')");
    expect(controllerSource).toContain("fileBrowserOpen ? 'browser' : null");
    expect(controllerSource).toContain("setIntent('subagent')");
    expect(controllerSource).toContain("setIntent('browser')");
  });
});
