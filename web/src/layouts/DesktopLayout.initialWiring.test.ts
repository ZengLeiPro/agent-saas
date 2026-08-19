import { describe, expect, it } from "vitest";
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
});
