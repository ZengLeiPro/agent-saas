import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { JobForm } from "./JobForm";
import type { ModelList } from "@/types/models";
import type { CronJob } from "./types";


const modelList: ModelList = {
  groups: [
    {
      id: "openai",
      name: "OpenAI",
      models: [{ id: "analysis", name: "分析模型" }],
    },
  ],
  default: "openai/default",
  allowCrossGroupSwitch: true,
  showGroupNames: true,
  showContextTokens: true,
  allowContextTokenDetails: false,
};

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

  it("编辑任务时首帧回显已保存的下拉值", () => {
    render(
      <JobForm
        mode="edit"
        initialJob={{
          ...baseJob,
          payload: {
            kind: "agentTurn",
            message: "生成每日报告",
            model: "openai/analysis",
          },
          notify: {
            enabled: true,
            channel: "both",
            dingtalk: { mode: "user", userId: "user-1" },
          },
        }}
        modelList={modelList}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    const selects = screen.getAllByRole("combobox");
    expect(selects[0].textContent).toContain("Cron 表达式");
    expect(selects[1].textContent).toContain("分析模型");
    expect(selects[2].textContent).toContain("Agent 执行");
    expect(selects[3].textContent).toContain("两者");
    expect(selects[4].textContent).toContain("主动私聊");
  });
});
