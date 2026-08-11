import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

vi.mock("@/hooks/useGroups", () => ({
  useGroups: () => ({
    groups: [],
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

vi.mock("@/hooks/useTenantBillingVisibility", () => ({
  useTenantBillingAllowance: () => ({ summary: null, allowance: null }),
}));

import { DesktopSessionSidebar } from "./DesktopSessionSidebar";

const session: ChatSessionIndexItem = {
  id: "session-1",
  title: "会话 A",
  createdAt: 1,
  updatedAt: 1,
};

function renderSidebar(activeTab: AppTab) {
  return render(
    <DesktopSessionSidebar
      sessions={[session]}
      activeSessionId={session.id}
      activeTab={activeTab}
      sidebarLayout="single"
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
});
