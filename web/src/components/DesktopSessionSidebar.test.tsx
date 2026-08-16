import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppTab, ChatSessionIndexItem } from "@/types/sidebar";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      username: "tester",
      tenantId: "tenant-1",
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
    editing: false,
    sorting: "recent",
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
  return render(
    <DesktopSessionSidebar
      sessions={sessions}
      activeSessionId={session.id}
      activeTab={activeTab}
      sidebarLayout={sidebarLayout}
      onSelect={vi.fn()}
      onNew={vi.fn()}
      onTabChange={vi.fn()}
    />,
  );
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
});
