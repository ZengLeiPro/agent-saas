import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { JobList } from "./JobList";
import type { CronJob } from "./types";

const job: CronJob = {
  id: "job-1",
  name: "每日报告",
  description: "生成昨日经营快报",
  enabled: true,
  owner: "user-1",
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
  payload: { kind: "agentTurn", message: "生成每日报告" },
  createdAtMs: 1,
  updatedAtMs: 1,
  state: { lastStatus: "ok" },
};

function renderList(overrides?: Partial<CronJob>) {
  const onSelect = vi.fn();
  const onToggle = vi.fn();
  render(
    <JobList
      jobs={[{ ...job, ...overrides }]}
      selectedId={null}
      currentUserId="user-1"
      onSelect={onSelect}
      onToggle={onToggle}
    />,
  );
  return { onSelect, onToggle };
}

describe("JobList", () => {
  it("切换启停开关不会连带选中卡片", async () => {
    const user = userEvent.setup();
    const { onSelect, onToggle } = renderList();

    await user.click(screen.getByRole("switch", { name: "禁用任务 每日报告" }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("点击卡片正文选中任务", async () => {
    const user = userEvent.setup();
    const { onSelect, onToggle } = renderList();

    await user.click(screen.getByText("每日报告"));

    expect(onSelect).toHaveBeenCalledWith("job-1");
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("列表里不显示任务状态", () => {
    renderList();

    expect(screen.queryByText("成功")).toBeNull();
  });

  it("列表里不再出现运行/编辑/删除等易误触操作", () => {
    renderList();

    // 这三个动作低频且有副作用，只在右侧详情（移动端 Dialog）里提供
    expect(screen.queryByRole("button", { name: /立即运行|运行/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /编辑/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /删除/ })).toBeNull();
  });

  it("任务运行中时禁止切换启停", () => {
    renderList({ state: { runningAtMs: Date.now() } });

    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  });
});
