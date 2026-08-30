import { describe, expect, it } from "vitest";
import source from "./MobileLayout.tsx?raw";
import detailSource from "@/components/BusinessStepDetailPanel.tsx?raw";

describe("MobileLayout 业务步骤详情接线", () => {
  it("移动端使用专用 business step Sheet，而不是复用文件预览 SlidePanel", () => {
    expect(source).toContain('businessStepDetailMode="mobile"');
    expect(source).toContain("businessStepPanelOpen={businessStepPanelOpen}");
    expect(detailSource).toContain("data-business-step-detail-sheet");
    expect(detailSource).toContain('side="bottom"');
  });

  it("文件预览、子 Agent 与导航抽屉打开时关闭步骤 Sheet", () => {
    expect(source).toContain("setBusinessStepPanelOpen(false)");
    expect(source).toContain("if (subagentTranscript || previewFilePath || sheetOpen)");
  });
});
