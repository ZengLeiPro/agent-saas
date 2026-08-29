import { describe, expect, it } from "vitest";

import { resolveChatRightPanelKind } from "./chatRightPanelIntent";

const allOpen = {
  businessStep: true,
  subagent: true,
  preview: true,
  system: true,
  browser: true,
};

describe("resolveChatRightPanelKind", () => {
  it("最近一次显式业务步骤选择优先于自动 system panel 和旧面板状态", () => {
    expect(resolveChatRightPanelKind("business-step", allOpen)).toBe("business-step");
  });

  it("文件预览与子 Agent 的显式选择可以切换当前 slot", () => {
    expect(resolveChatRightPanelKind("preview", allOpen)).toBe("preview");
    expect(resolveChatRightPanelKind("subagent", allOpen)).toBe("subagent");
  });

  it("显式面板关闭后按确定性顺序回退，system 不会反向覆盖有效 intent", () => {
    expect(resolveChatRightPanelKind("business-step", { ...allOpen, businessStep: false, subagent: false, preview: false })).toBe("system");
    expect(resolveChatRightPanelKind(null, { ...allOpen, businessStep: false, subagent: false, preview: false })).toBe("system");
  });

  it("没有任何可用面板时返回 null", () => {
    expect(resolveChatRightPanelKind(null, {
      businessStep: false,
      subagent: false,
      preview: false,
      system: false,
      browser: false,
    })).toBeNull();
  });
});
