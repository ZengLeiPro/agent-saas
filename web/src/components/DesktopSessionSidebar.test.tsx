import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppTab, ChatSessionIndexItem } from "@/types/sidebar";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      username: "tester",
      tenantId: "tenant-1",
      tenantName: "开沿科技",
      preferences: { showSessionListAvatar: false },
    },
    accounts: [],
    switchAccount: vi.fn(),
    authEnabled: true,
  }),
}));

const groupsState = vi.hoisted(() => ({ current: [] as Array<Record<string, unknown>> }));

vi.mock("@/hooks/useGroups", () => ({
  useGroups: () => ({
    groups: groupsState.current,
    loading: false,
    editing: null,
    sorting: { mode: "recent", order: [] },
    addSessionsToGroup: vi.fn(),
    cancelEditing: vi.fn(),
    commitEditing: vi.fn(),
    createGroup: vi.fn(),
    deleteGroup: vi.fn(),
    enterEditing: vi.fn(),
    removeSessionsFromGroup: vi.fn(),
    renameGroup: vi.fn(),
    reorderDraft: vi.fn(),
    setSortingMode: vi.fn(),
  }),
}));

vi.mock("@/hooks/useSessionSearch", () => ({
  useSessionSearch: () => ({
    hits: [],
    isSearching: false,
    isLoadingMore: false,
    hasMore: false,
    error: null,
    loadMore: vi.fn(),
  }),
}));

const billingState = vi.hoisted(() => ({
  current: { summary: null, allowance: null } as {
    summary: { balanceCredits: number; billingEnabled: boolean; billingMode: string } | null;
    allowance: { credits: number; source: "member" | "tenant" } | null;
  },
}));
const billingMiniBadgeProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock("@/hooks/useTenantBillingVisibility", () => ({
  useTenantBillingAllowance: () => billingState.current,
}));

vi.mock("@/components/BillingMiniBadge", () => ({
  BillingMiniBadge: (props: Record<string, unknown>) => {
    billingMiniBadgeProps.current = props;
    return <div data-testid="sidebar-billing-card" />;
  },
}));

import { DesktopSessionSidebar } from "./DesktopSessionSidebar";

const session: ChatSessionIndexItem = {
  id: "session-1",
  title: "会话 A",
  createdAt: 1,
  updatedAt: 1,
};

function renderSidebar(
  activeTab: AppTab,
  sessions: ChatSessionIndexItem[] = [session],
  sidebarLayout: "single" | "double" = "single",
) {
  const onNew = vi.fn();
  return {
    ...render(
      <DesktopSessionSidebar
        sessions={sessions}
        activeSessionId={session.id}
        activeTab={activeTab}
        sidebarLayout={sidebarLayout}
        onSelect={vi.fn()}
        onNew={onNew}
        onTabChange={vi.fn()}
      />,
    ),
    onNew,
  };
}

function getSessionRow() {
  const row = screen.getByText(session.title).closest(".cursor-pointer");
  expect(row).not.toBeNull();
  return row!;
}

describe("桌面侧边栏会话激活态", () => {
  beforeEach(() => {
    groupsState.current = [];
    billingState.current = { summary: null, allowance: null };
    billingMiniBadgeProps.current = null;
  });

  it("会话页继续高亮当前会话", () => {
    renderSidebar("chat");

    expect(getSessionRow().className).toContain("bg-brand-accent-soft");
  });

  it.each<AppTab>(["capabilities", "cron"])(
    "%s 页面只高亮导航项，不再高亮旧会话",
    (activeTab) => {
      renderSidebar(activeTab);

      expect(getSessionRow().className).not.toContain("bg-brand-accent-soft");
    },
  );

  it.each([
    ["waiting_user", "待补充"],
    ["waiting_approval", "待处理"],
  ] as const)("人工等待态 %s 显示 %s 且不转圈", (runtimeStatus, label) => {
    renderSidebar("chat", [{ ...session, isRunning: true, runtimeStatus }]);

    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByLabelText("会话运行中")).toBeNull();
  });

  it.each(["single", "double"] as const)("%s 布局的任务看板分组使用 violet 图标", (sidebarLayout) => {
    groupsState.current = [{
      id: "taskboard:board-1",
      userId: "user-1",
      name: "研发交付",
      kind: "taskboard",
      taskboardId: "board-1",
      sessionIds: [session.id],
      createdAt: 1,
      updatedAt: 1,
    }];

    const { container } = renderSidebar("chat", [session], sidebarLayout);

    expect(screen.getAllByText("研发交付").length).toBeGreaterThan(0);
    expect(container.querySelector(".text-violet-600")).not.toBeNull();
  });

  it("头像菜单使用右侧展开的积分卡片", () => {
    billingState.current = {
      summary: { balanceCredits: 1280, billingEnabled: true, billingMode: "trial" },
      allowance: { credits: 1280, source: "tenant" },
    };
    renderSidebar("chat");

    fireEvent.click(screen.getByRole("button", { name: /tester/ }));

    expect(screen.getByTestId("sidebar-billing-card")).toBeTruthy();
    expect(billingMiniBadgeProps.current).toMatchObject({
      variant: "menu",
      sessionId: "session-1",
    });
  });

  it("左下角头像行用户名右侧展示组织名", () => {
    renderSidebar("chat");

    const trigger = screen.getByRole("button", { name: /tester/ });
    expect(trigger.textContent).toContain("开沿科技");
  });

  it("批量选择支持全选、取消全选和部分选中的中间态", () => {
    const sessionB = { ...session, id: "session-2", title: "会话 B", updatedAt: 2 };
    renderSidebar("chat", [session, sessionB]);

    fireEvent.click(screen.getByRole("button", { name: "选择" }));
    const selectAll = screen.getAllByRole("checkbox", { name: "全选当前列表" })[0];
    expect(selectAll.getAttribute("data-state")).toBe("unchecked");

    fireEvent.click(selectAll);
    expect(screen.getAllByRole("checkbox", { name: "取消全选当前列表" })
      .every((checkbox) => checkbox.getAttribute("data-state") === "checked")).toBe(true);

    fireEvent.click(screen.getByText("会话 A"));
    expect(screen.getAllByRole("checkbox", { name: "全选当前列表" })
      .every((checkbox) => checkbox.getAttribute("data-state") === "indeterminate")).toBe(true);
  });

  it("新会话可选择已有手动分组且不暴露系统分组", () => {
    groupsState.current = [
      { id: "manual-1", userId: "user-1", name: "项目组", kind: "manual", sessionIds: [], createdAt: 1, updatedAt: 1 },
      { id: "cron-1", userId: "user-1", name: "晨报", kind: "cron", sessionIds: [], createdAt: 1, updatedAt: 1 },
    ];
    const { onNew } = renderSidebar("chat");

    fireEvent.click(screen.getByRole("button", { name: "新建到分组" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: /项目组/ })).toBeTruthy();
    expect(dialog.queryByRole("button", { name: /晨报/ })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: /项目组/ }));

    expect(onNew).toHaveBeenCalledWith("manual-1");
  });
});
