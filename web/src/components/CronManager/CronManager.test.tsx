import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CronManager } from "./index";

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

function ExternalHeaderHarness() {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);

  return (
    <>
      <div ref={setTarget} data-testid="cron-header-actions" />
      <CronManager headerActionsTarget={target} />
    </>
  );
}

describe("CronManager 桌面布局", () => {
  it("使用全局 Header 的唯一操作区，并在新建态原位切换操作", async () => {
    const user = userEvent.setup();
    const { container } = render(<ExternalHeaderHarness />);
    const header = screen.getByTestId("cron-header-actions");

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
});
