import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OrgAgentComposerChip } from "./ChatTabContent";

const expert = {
  id: "agent-product",
  name: "产品选型助手",
  description: "负责产品选型",
  starterPrompts: [],
  skillCount: 1,
};

describe("OrgAgentComposerChip", () => {
  it("输入框上方新对话入口保持当前企业专家语义", () => {
    const onNewConversation = vi.fn();
    render(
      <OrgAgentComposerChip
        orgAgent={expert}
        onNewConversation={onNewConversation}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "使用产品选型助手发起新对话" }));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it("停用或无权限时不渲染新对话按钮", () => {
    render(<OrgAgentComposerChip orgAgent={expert} />);
    expect(screen.queryByRole("button", { name: /发起新对话/ })).toBeNull();
  });

  it("存在多个专家时可从输入框标签切换", () => {
    const onSwitch = vi.fn();
    render(<OrgAgentComposerChip orgAgent={expert} onSwitch={onSwitch} />);
    fireEvent.click(screen.getByRole("button", { name: "切换" }));
    expect(onSwitch).toHaveBeenCalledTimes(1);
  });
});
