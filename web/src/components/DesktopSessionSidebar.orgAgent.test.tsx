import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OrgAgentSidebarSection } from "./DesktopSessionSidebar";

const agent = { id: "agent-product", name: "产品选型助手", avatar: "⚙️" };
const sessions = [
  {
    id: "session-old",
    title: "旧线程",
    createdAt: 1_000,
    updatedAt: 2_000,
    orgAgentId: agent.id,
  },
  {
    id: "session-new",
    title: "最新线程",
    createdAt: 3_000,
    updatedAt: 4_000,
    orgAgentId: agent.id,
  },
];

describe("OrgAgentSidebarSection", () => {
  it("卡片主体打开该 Agent 最近更新的会话", () => {
    const onSelectSession = vi.fn();
    render(
      <OrgAgentSidebarSection
        agents={[agent]}
        sessions={sessions}
        onSelectSession={onSelectSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开产品选型助手最近对话" }));
    expect(onSelectSession).toHaveBeenCalledWith("session-new");
  });

  it("新对话按钮只创建新会话，不冒泡打开旧会话", () => {
    const onSelectSession = vi.fn();
    const onStartOrgAgentSession = vi.fn();
    render(
      <OrgAgentSidebarSection
        agents={[agent]}
        sessions={sessions}
        onSelectSession={onSelectSession}
        onStartOrgAgentSession={onStartOrgAgentSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "使用产品选型助手发起新对话" }));
    expect(onStartOrgAgentSession).toHaveBeenCalledWith(agent.id);
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it("历史对话按更新时间倒序展示并可恢复原线程", () => {
    const onSelectSession = vi.fn();
    render(
      <OrgAgentSidebarSection
        agents={[agent]}
        sessions={sessions}
        onSelectSession={onSelectSession}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看产品选型助手历史对话" }));
    const history = screen.getByLabelText("产品选型助手历史对话");
    const items = within(history).getAllByRole("button");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("最新线程"),
      expect.stringContaining("旧线程"),
    ]);

    fireEvent.click(within(history).getByRole("button", { name: /旧线程/ }));
    expect(onSelectSession).toHaveBeenCalledWith("session-old");
  });
});
