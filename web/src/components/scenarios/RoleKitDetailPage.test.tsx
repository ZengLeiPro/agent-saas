import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioItem, ScenarioRole } from "@agent/shared";

import { RoleKitDetailPage } from "./RoleKitDetailPage";

vi.mock("./useIndustryFilter", () => ({
  useIndustryFilter: () => ({ activeIndustry: "all", setActiveIndustry: vi.fn() }),
  matchIndustry: () => true,
  INDUSTRY_ALL: "all",
}));

const role: ScenarioRole = {
  id: "boss",
  name: "老板/总经理",
  sort: 1,
  roleWelcomeMessage: {
    default: "每天先看经营重点。",
    internal: "内部管理先看异常。",
  },
  roleTopPains: ["信息太散", "决策滞后"],
  roleP0DataSources: [
    {
      name: "客户跟进表",
      difficulty: "self_service_lt_30min",
      afterConnected: "自动整理客户变化",
      customerAction: "上传表格即可",
    },
  ],
  defaultRecurringId: "boss-1",
  retentionPath7Day: [
    {
      day: "D1",
      mainlineAiAction: "每天早上发经营简报",
      backupCsmAction: "客户成功不主动推销",
      sellUpBanned: true,
    },
  ],
};

const scenario: ScenarioItem = {
  id: "boss-1",
  title: "竞品晨报",
  role: "boss",
  industries: ["manufacturing"],
  mode: "recurring",
  pitch: "每天汇总重点变化",
  story: "输入对象 → 输出摘要",
  promptTemplate: "请跟进 {{target}}",
  slots: [{ key: "target", label: "对象", example: "同行A" }],
  requires: ["web"],
  recommendCron: true,
  firstAhaMode: "zero_input_example",
  dataDependencyLevel: "zero",
  skillCandidates: [
    {
      name: "竞品判断口径",
      level: "tenant",
      firstSampleGate: "至少完成 1 次真实输出",
      freshnessMechanism: "每周复核一次",
      roiVisibility: "老板看日报打开情况",
    },
  ],
  cannotPromise: ["不承诺替代人工决策"],
  day1PathSteps: [
    {
      stage: "T+0-30min",
      userAction: "输入竞品名",
      aiAction: "整理公开动态",
      userSees: "一份晨报",
    },
  ],
};

describe("RoleKitDetailPage", () => {
  it("renders the first four sections and tries a scenario", () => {
    const onTryScenario = vi.fn();
    render(<RoleKitDetailPage role={role} scenarios={[scenario]} onTryScenario={onTryScenario} />);

    expect(screen.getByText("老板/总经理开箱包")).toBeTruthy();
    expect(screen.getByText("该岗位最痛的 5 个问题")).toBeTruthy();
    expect(screen.getByText("首日 4 小时能干成什么")).toBeTruthy();
    expect(screen.getByText("5 条示例起手指令")).toBeTruthy();

    fireEvent.click(screen.getAllByText("试一试")[0]);
    expect(onTryScenario).toHaveBeenCalledWith(expect.objectContaining({ id: "boss-1" }));
  });

  it("expands later sections with friendly labels and hides banned backup actions", () => {
    render(<RoleKitDetailPage role={role} scenarios={[scenario]} onTryScenario={vi.fn()} />);

    fireEvent.click(screen.getByText("需要接入的数据源"));
    expect(screen.getByText("自服务 30 分钟内可开")).toBeTruthy();

    fireEvent.click(screen.getByText("值得沉淀成公司规范的能力"));
    expect(screen.getByText("公司规范")).toBeTruthy();

    fireEvent.click(screen.getByText("陪跑路径：4 小时到 7 天"));
    expect(screen.getByText("每天早上发经营简报")).toBeTruthy();
    expect(screen.queryByText("客户成功不主动推销")).toBeNull();

    fireEvent.click(screen.getByText("我们不承诺什么"));
    expect(screen.getByText("不承诺替代人工决策")).toBeTruthy();
  });
});
