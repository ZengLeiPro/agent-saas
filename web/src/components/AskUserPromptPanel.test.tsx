import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AskUserPromptPanel } from "./AskUserPromptPanel";
import type { AskUserQuestion } from "./AskUserBlock";

describe("AskUserPromptPanel", () => {
  it("selects a single option before submitting", () => {
    const onSubmit = vi.fn();
    const questions: AskUserQuestion[] = [{
      question: "您的品牌属于哪种背景？",
      header: "品牌背景",
      multiSelect: false,
      options: [
        { label: "海外/跨境品牌首次入华", description: "" },
        { label: "本土新品牌刚起步", description: "" },
      ],
    }];

    render(<AskUserPromptPanel questions={questions} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /海外\/跨境品牌首次入华/ }));
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "提交" }));
    expect(onSubmit).toHaveBeenCalledWith({
      "您的品牌属于哪种背景？": "海外/跨境品牌首次入华",
    });
  });

  it("renders self-contained context below the question title", () => {
    render(
      <AskUserPromptPanel
        questions={[{
          question: "是否将这些待修复项写入任务中心？",
          header: "确认写入",
          description: "已识别密码修改流程中的三项问题；确认后只创建任务，不会立即派发执行。",
          multiSelect: false,
          options: [
            { label: "确认写入", description: "创建任务但不派发执行" },
            { label: "取消", description: "不创建任务" },
          ],
        }]}
        onSubmit={vi.fn()}
      />,
    );

    const title = screen.getByRole("heading", { name: "是否将这些待修复项写入任务中心？" });
    const description = screen.getByText(
      "已识别密码修改流程中的三项问题；确认后只创建任务，不会立即派发执行。",
    );
    expect(title.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("submits multi-select answers as an array", () => {
    const onSubmit = vi.fn();
    const questions: AskUserQuestion[] = [{
      question: "需要哪些内容？",
      header: "内容",
      multiSelect: true,
      options: [
        { label: "合规说明", description: "" },
        { label: "流量打法", description: "" },
      ],
    }];

    render(<AskUserPromptPanel questions={questions} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /合规说明/ }));
    fireEvent.click(screen.getByRole("button", { name: /流量打法/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交" }));

    expect(onSubmit).toHaveBeenCalledWith({
      "需要哪些内容？": ["合规说明", "流量打法"],
    });
  });

  it("can collapse the form and expand it again", () => {
    render(
      <AskUserPromptPanel
        questions={[{
          question: "需要查看正文吗？",
          header: "阅读",
          multiSelect: false,
          options: [{ label: "需要", description: "" }],
        }]}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "折叠提问表单" }));
    expect(screen.queryByText("需要查看正文吗？")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开提问表单" }));
    expect(screen.getByText("需要查看正文吗？")).toBeTruthy();
  });
});
