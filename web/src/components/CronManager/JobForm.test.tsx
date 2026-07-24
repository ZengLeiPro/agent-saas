import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { JobForm } from "./JobForm";
import type { CronJob } from "./types";

const baseJob: CronJob = {
  id: "job-1",
  name: "每日报告",
  enabled: true,
  schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
  payload: { kind: "agentTurn", message: "生成每日报告" },
  createdAtMs: 1,
  updatedAtMs: 1,
  state: {},
};

describe("JobForm", () => {
  it("编辑任务时回填调度类型", async () => {
    render(
      <JobForm
        mode="edit"
        initialJob={baseJob}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    expect(
      (await screen.findByLabelText("Cron 表达式（5 字段）") as HTMLInputElement).value,
    ).toBe("0 9 * * *");
    expect((screen.getByLabelText("时区") as HTMLInputElement).value).toBe(
      "Asia/Shanghai",
    );
  });
});
