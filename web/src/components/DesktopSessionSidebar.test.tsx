import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { governanceRoute } from "@/lib/governanceNavigation";
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
  extraProps: Partial<ComponentProps<typeof DesktopSessionSidebar>> = {},
) {
  const onNew = vi.fn();
  const build = (props = extraProps) => (
    <DesktopSessionSidebar
      sessions={sessions}
      activeSessionId={session.id}
      activeTab={activeTab}
      sidebarLayout={sidebarLayout}
      onSelect={vi.fn()}
      onNew={onNew}
      onTabChange={vi.fn()}
      {...props}
    />
  );
  const rendered = render(build());
  return {
    ...rendered,
    onNew,
    rerenderSidebar: (props: Partial<ComponentProps<typeof DesktopSessionSidebar>>) => rendered.rerender(build({ ...extraProps, ...props })),
  };
}

function getSessionRow() {
  const row = screen.getByText(session.title).closest(".cursor-pointer");
  expect(row).not.toBeNull();
  return row!;
}

describe("桌面侧边栏会话交互与视觉状态", () => {
  beforeEach(() => {
    groupsState.current = [];
    billingState.current = { summary: null, allowance: null };
    billingMiniBadgeProps.current = null;
  });

  it("会话页继续高亮当前会话", () => {
    renderSidebar("chat");

    expect(getSessionRow().className).toContain("bg-brand-accent-soft");
    expect(getSessionRow().className).not.toContain("before:bg-brand-accent");
  });

  it.each<AppTab>(["capabilities", "cron"])(
    "%s 页面只高亮导航项，不再高亮旧会话",
    (activeTab) => {
      renderSidebar(activeTab);

      expect(getSessionRow().className).not.toContain("bg-brand-accent-soft");
    },
  );

  it.each(["single", "double"] as const)("%s 布局统一使用分组同款小未读红点", (sidebarLayout) => {
    const { container } = renderSidebar(
      "chat",
      [{ ...session, hasUnreadAiReply: true }],
      sidebarLayout,
    );
    const unreadDots = container.querySelectorAll(".rounded-full.bg-destructive");

    expect(unreadDots.length).toBeGreaterThan(0);
    expect([...unreadDots].every((dot) => dot.classList.contains("size-1.5"))).toBe(true);
    expect(container.querySelector(".rounded-full.bg-destructive.size-2")).toBeNull();
  });

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

  it.each(["single", "double"] as const)("%s 布局的新建会话区域不展示分组快捷入口", (sidebarLayout) => {
    renderSidebar("chat", [session], sidebarLayout);

    expect(screen.queryByRole("button", { name: "新建到分组" })).toBeNull();
  });

  it("双栏只保留内部栏位分割线，侧边栏外缘不描边", () => {
    const collapsed = renderSidebar("capabilities", [session], "double", { activeSessionId: null });
    expect(screen.getByTestId("desktop-sidebar-main-panel").classList.contains("border-r")).toBe(false);
    collapsed.unmount();

    renderSidebar("chat", [session], "double");
    expect(screen.getByTestId("desktop-sidebar-main-panel").classList.contains("border-r")).toBe(true);
  });

  it("窄态临时隐藏第二栏，宽度恢复后还原原有展开状态", () => {
    const { container, rerenderSidebar } = renderSidebar("chat", [session], "double");
    const sidebar = container.querySelector("aside");
    const secondaryPanel = screen.getByTestId("desktop-sidebar-secondary-panel");

    rerenderSidebar({ responsiveMode: "secondary-hidden" });
    expect(sidebar?.style.width).toBe("160px");
    expect(screen.getByTestId("desktop-sidebar-secondary-panel")).toBe(secondaryPanel);
    expect(secondaryPanel.classList.contains("hidden")).toBe(true);
    expect(secondaryPanel.getAttribute("aria-hidden")).toBe("true");

    rerenderSidebar({ responsiveMode: "none" });
    expect(sidebar?.style.width).toBe("432px");
    expect(screen.getByTestId("desktop-sidebar-secondary-panel")).toBe(secondaryPanel);
    expect(secondaryPanel.classList.contains("hidden")).toBe(false);
  });

  it("响应式临时隐藏整栏不清空会话搜索状态", () => {
    const { container, rerenderSidebar } = renderSidebar("chat", [session], "double");
    const search = screen.getByLabelText("搜索会话内容") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "保留我" } });

    rerenderSidebar({ responsiveMode: "hidden" });
    expect(container.querySelector("aside")?.classList.contains("hidden")).toBe(true);
    rerenderSidebar({ responsiveMode: "none" });

    expect((screen.getByLabelText("搜索会话内容") as HTMLInputElement).value).toBe("保留我");
  });

  it("普通用户头像菜单不显示分析入口", () => {
    renderSidebar("chat");

    fireEvent.click(screen.getByRole("button", { name: /tester/ }));

    expect(screen.queryByRole("button", { name: "分析" })).toBeNull();
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
  });

  it("组织管理员头像菜单显示分析入口", () => {
    renderSidebar("chat", [session], "single", {
      isAdmin: true,
      settingsAccess: {
        status: "ready", personalAllowed: true, tenantEntryAllowed: true, platformEntryAllowed: false, retry: vi.fn(),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /tester/ }));

    expect(screen.getByRole("button", { name: "分析" })).toBeTruthy();
  });

  it("平台管理员头像菜单显示统一分析与设置入口", () => {
    const onOpenAnalysis = vi.fn();
    renderSidebar("chat", [session], "single", {
      isAdmin: true,
      isPlatformAdmin: true,
      onOpenAnalysis,
      settingsAccess: {
        status: "ready", personalAllowed: true, tenantEntryAllowed: true, platformEntryAllowed: true, retry: vi.fn(),
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /tester/ }));

    expect(screen.getByRole("button", { name: "分析" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "设置" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "分析" }));
    expect(onOpenAnalysis).toHaveBeenCalledOnce();
  });

  it.each(["single", "double"] as const)("%s 布局进入分析后整块替换常规侧边栏", async (sidebarLayout) => {
    const onAnalysisNavigate = vi.fn();
    const onCloseAnalysis = vi.fn();
    renderSidebar("platform-admin", [session], sidebarLayout, {
      isAdmin: true,
      isPlatformAdmin: true,
      settingsAccess: {
        status: "ready", personalAllowed: true, tenantEntryAllowed: true, platformEntryAllowed: true, retry: vi.fn(),
      },
      analysisMode: true,
      analysisRoute: governanceRoute("platform.runtime.runs"),
      onAnalysisNavigate,
      onCloseAnalysis,
    });

    expect(await screen.findByTestId("unified-analysis-sidebar")).toBeTruthy();
    expect(screen.queryByText("新建会话")).toBeNull();
    expect(screen.queryByText("会话 A")).toBeNull();
    expect(screen.getByText("平台分析")).toBeTruthy();
    expect(screen.getByText("组织分析")).toBeTruthy();
    expect(screen.getByRole("button", { name: "运行" }).getAttribute("aria-current")).toBe("page");

    fireEvent.click(screen.getByRole("button", { name: "执行效率" }));
    expect(onAnalysisNavigate).toHaveBeenCalledWith("platform.runtime.efficiency");
    fireEvent.click(screen.getByRole("button", { name: "返回主界面" }));
    expect(onCloseAnalysis).toHaveBeenCalledOnce();
  });

  it.each(["single", "double"] as const)("%s 布局进入设置后整块替换常规侧边栏", async (sidebarLayout) => {
    const onCloseSettings = vi.fn();
    const onSettingsNavigate = vi.fn();
    renderSidebar("chat", [session], sidebarLayout, {
      isAdmin: true,
      isPlatformAdmin: true,
      settingsAccess: {
        status: "ready", personalAllowed: true, tenantEntryAllowed: true, platformEntryAllowed: true, retry: vi.fn(),
      },
      settingsMode: true,
      settingsTarget: "platform",
      activeSettingsSection: "models",
      onCloseSettings,
      onSettingsNavigate,
    });

    const settingsSidebar = await screen.findByTestId("unified-settings-sidebar");
    expect(settingsSidebar.classList.contains("border-r")).toBe(false);
    expect(screen.queryByText("新建会话")).toBeNull();
    expect(screen.queryByLabelText("搜索会话内容")).toBeNull();
    expect(screen.queryByText("会话 A")).toBeNull();
    expect(screen.getByText("个人设置")).toBeTruthy();
    expect(screen.getAllByText("组织管理").length).toBeGreaterThan(0);
    expect(screen.getByText("平台管理")).toBeTruthy();
    expect(screen.getByRole("button", { name: "模型" }).getAttribute("aria-current")).toBe("page");

    fireEvent.click(screen.getByRole("button", { name: "系统配置" }));
    expect(onSettingsNavigate).toHaveBeenCalledWith("platform", "system");
    fireEvent.click(screen.getByRole("button", { name: "返回主界面" }));
    expect(onCloseSettings).toHaveBeenCalledOnce();
  });

  it("统一设置不回退普通会话态的管理员角色", async () => {
    renderSidebar("chat", [session], "single", {
      isAdmin: true,
      isPlatformAdmin: true,
      settingsMode: true,
      settingsTarget: "personal",
    });

    expect(await screen.findByText("个人设置")).toBeTruthy();
    expect(screen.queryByText("组织管理")).toBeNull();
    expect(screen.queryByText("平台管理")).toBeNull();
  });

  it("普通用户的统一设置菜单隐藏组织和平台分组", async () => {
    renderSidebar("chat", [session], "single", {
      settingsMode: true,
      settingsTarget: "personal",
      activeSettingsSection: "account-security",
    });

    expect(await screen.findByText("个人设置")).toBeTruthy();
    expect(screen.queryByText("平台管理")).toBeNull();
    expect(screen.queryAllByText("组织管理")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "账户与安全" })).toBeTruthy();
  });
});
