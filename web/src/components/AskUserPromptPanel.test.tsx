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
});
