import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OrgAgentConversationHeader } from "./ChatTabContent";

describe("OrgAgentConversationHeader", () => {
  it("会话头部新对话入口保持当前专职 Agent 语义", () => {
    const onNewConversation = vi.fn();
    render(
      <OrgAgentConversationHeader
        orgAgent={{ id: "agent-product", name: "产品选型助手" }}
        onNewConversation={onNewConversation}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "使用产品选型助手发起新对话" }));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it("停用或无权限时不渲染新对话按钮", () => {
    render(<OrgAgentConversationHeader orgAgent={{ id: "agent-product", name: "产品选型助手" }} />);
    expect(screen.queryByRole("button", { name: /发起新对话/ })).toBeNull();
  });
});
