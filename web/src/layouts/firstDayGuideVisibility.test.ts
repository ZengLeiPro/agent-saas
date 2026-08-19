import { describe, expect, it } from "vitest";
import type { MessageItem } from "@/components/types";

import { hasSuccessfulFinalOutput } from "./firstDayGuideVisibility";

describe("hasSuccessfulFinalOutput", () => {
  it("中间文本块结束时仍不显示引导", () => {
    const messages: MessageItem[] = [
      { id: "text-1", type: "text", content: "先处理第一步", streaming: false, runId: "run-1" },
      { id: "tool-1", type: "tool_use", toolName: "Read", toolInput: "{}", toolId: "tool-1", executionStatus: "running" },
    ];

    expect(hasSuccessfulFinalOutput(messages)).toBe(false);
  });

  it("失败终态不显示引导", () => {
    const messages: MessageItem[] = [
      { id: "text-1", type: "text", content: "执行失败", streaming: false, finalOutput: false, runId: "run-1" },
    ];

    expect(hasSuccessfulFinalOutput(messages)).toBe(false);
  });

  it("成功 done 标记 finalOutput 后才显示引导", () => {
    const messages: MessageItem[] = [
      { id: "text-1", type: "text", content: "处理中", streaming: false, runId: "run-1" },
      { id: "text-2", type: "text", content: "已完成", streaming: false, finalOutput: true, runId: "run-1" },
    ];

    expect(hasSuccessfulFinalOutput(messages)).toBe(true);
  });
});
