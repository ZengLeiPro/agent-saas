import { useState } from "react";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CronManager, cronViewFromLocation } from "./index";

const mocks = vi.hoisted(() => ({
  refreshStatus: vi.fn(async () => undefined),
  addJob: vi.fn(async () => undefined),
  updateJob: vi.fn(async () => undefined),
  deleteJob: vi.fn(async () => undefined),
  runJob: vi.fn(async () => undefined),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "user-1" }, authEnabled: true }),
}));

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("./hooks", () => ({
  useCronStatus: () => ({ refresh: mocks.refreshStatus }),
  useCronJobs: () => ({
    jobs: [],
    addJob: mocks.addJob,
    updateJob: mocks.updateJob,
    deleteJob: mocks.deleteJob,
    runJob: mocks.runJob,
  }),
  useRunHistory: () => ({ entries: [], loading: false, error: null }),
  useDingtalkSessions: () => ({ sessions: [] }),
  useModelList: () => null,
}));

vi.mock("./JobForm", () => ({
  JobForm: () => <form id="cron-job-form" aria-label="定时任务表单" />,
}));

vi.mock("@/components/TaskBoard", () => ({
  TaskBoardView: () => (
    <div>
      任务看板视图
      <input aria-label="看板草稿" defaultValue="" />
    </div>
  ),
}));

function ExternalHeaderHarness() {
  const [navigationTarget, setNavigationTarget] = useState<HTMLDivElement | null>(null);
  const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null);

  return (
    <>
      <div ref={setNavigationTarget} data-testid="cron-header-navigation" />
      <div ref={setActionsTarget} data-testid="cron-header-actions" />
      <CronManager
        headerNavigationTarget={navigationTarget}
        headerActionsTarget={actionsTarget}
      />
    </>
  );
}

describe("CronManager 桌面布局", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/cron");
  });

  it("使用全局 Header 的唯一操作区，并在新建态原位切换操作", async () => {
    const user = userEvent.setup();
    const { container } = render(<ExternalHeaderHarness />);
    const navigation = screen.getByTestId("cron-header-navigation");
    const header = screen.getByTestId("cron-header-actions");

    expect(within(navigation).getByRole("tab", { name: "定时任务" })).toBeTruthy();
    expect(within(navigation).getByRole("tab", { name: "任务看板" })).toBeTruthy();
    expect(within(navigation).getByRole("tablist").className).toContain("bg-brand-50");
    expect(within(navigation).getByRole("tablist").className).toContain("h-10");
    expect(within(navigation).getByRole("tablist").className).toContain("w-[15rem]");
    expect(navigation.querySelector<HTMLElement>("[data-task-center-tab-indicator]")?.style.transform).toBe("translateX(0%)");
    expect(within(header).getByRole("button", { name: "刷新" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "新建" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "定时任务" })).toBeNull();
    expect(container.innerHTML).not.toContain("max-w-5xl");

    await user.click(within(header).getByRole("button", { name: "新建" }));

    expect(within(header).queryByRole("button", { name: "刷新" })).toBeNull();
    expect(within(header).queryByRole("button", { name: "新建" })).toBeNull();
    expect(within(header).getByRole("button", { name: "取消" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "创建任务" })).toBeTruthy();
    expect(screen.getByText("创建定时任务")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "创建任务" })).toHaveLength(1);

    await user.click(within(header).getByRole("button", { name: "取消" }));

    expect(within(header).getByRole("button", { name: "刷新" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "新建" })).toBeTruthy();
    expect(screen.queryByText("创建定时任务")).toBeNull();
  });

  it("在定时任务与任务看板间切换独立路径，并响应 URL 返回", async () => {
    const user = userEvent.setup();
    render(<CronManager />);

    await user.click(screen.getByRole("tab", { name: "任务看板" }));
    expect(window.location.pathname).toBe("/taskboard");
    expect(window.location.search).toBe("");
    expect(window.localStorage.getItem("task-center:last-view")).toBe("board");
    expect(screen.getByText("任务看板视图")).toBeTruthy();
    expect(document.querySelector<HTMLElement>("[data-task-center-tab-indicator]")?.style.transform).toBe("translateX(100%)");

    act(() => {
      window.history.replaceState({}, "", "/cron");
      window.dispatchEvent(new Event("popstate"));
    });
    expect(await screen.findByText("选择左侧任务查看运行历史")).toBeTruthy();
    expect(window.location.search).toBe("");
    expect(window.localStorage.getItem("task-center:last-view")).toBe("schedule");
  });

  it("刷新任务看板独立路径时直接恢复任务看板", () => {
    expect(cronViewFromLocation({ pathname: "/cron", search: "?view=board" })).toBe("board");
    window.history.replaceState({}, "", "/taskboard");
    render(<CronManager />);

    expect(screen.getByRole("tab", { name: "任务看板" }).getAttribute("data-state")).toBe("active");
    expect(screen.getByText("任务看板视图")).toBeTruthy();
    expect(window.location.pathname).toBe("/taskboard");
  });

  it("组织控制台切换任务看板时保留 tenant-admin shell、路径和现有查询", async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, "", "/tenant-admin/governance/automation?org=acme&scope=mine");
    render(<CronManager />);

    await user.click(screen.getByRole("tab", { name: "任务看板" }));
    expect(window.location.pathname).toBe("/tenant-admin/governance/automation");
    expect(new URLSearchParams(window.location.search).get("org")).toBe("acme");
    expect(new URLSearchParams(window.location.search).get("scope")).toBe("mine");
    expect(new URLSearchParams(window.location.search).get("view")).toBe("board");
    expect(screen.getByText("任务看板视图")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "定时任务" }));
    expect(window.location.pathname).toBe("/tenant-admin/governance/automation");
    expect(new URLSearchParams(window.location.search).get("org")).toBe("acme");
    expect(new URLSearchParams(window.location.search).get("scope")).toBe("mine");
    expect(new URLSearchParams(window.location.search).has("view")).toBe(false);
  });

  it("切换二级视图保持已打开表单和看板草稿", async () => {
    const user = userEvent.setup();
    render(<CronManager />);

    await user.click(screen.getByRole("button", { name: "新建" }));
    expect(screen.getByText("创建定时任务")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "任务看板" }));
    const draft = screen.getByRole("textbox", { name: "看板草稿" }) as HTMLInputElement;
    await user.type(draft, "不要丢失");

    await user.click(screen.getByRole("tab", { name: "定时任务" }));
    expect(screen.getByText("创建定时任务")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "任务看板" }));
    expect((screen.getByRole("textbox", { name: "看板草稿" }) as HTMLInputElement).value).toBe("不要丢失");
  });
});
