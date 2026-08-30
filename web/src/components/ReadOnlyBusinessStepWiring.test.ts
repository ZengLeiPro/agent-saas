import { describe, expect, it } from "vitest";
import qaSessionSource from "./QaConsole/SessionDetailDialog.tsx?raw";
import sessionShareSource from "./SessionSharePage.tsx?raw";

describe("只读会话业务步骤详情接线", () => {
  it("质检会话保留只读步骤详情入口及其上层文件预览", () => {
    expect(qaSessionSource).toContain('businessStepDetailMode="mobile"');
    expect(qaSessionSource).toContain("业务步骤详情使用只读 Sheet");
    expect(qaSessionSource).toContain("nestedLayer");
  });

  it("公开分享页同样接入只读步骤 Sheet，文件预览位于其上层", () => {
    expect(sessionShareSource).toContain('businessStepDetailMode="mobile"');
    expect(sessionShareSource).toContain("nestedLayer");
  });
});
