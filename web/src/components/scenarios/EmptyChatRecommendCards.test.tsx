import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScenarioItem, ScenarioLibraryResponse } from "@agent/shared";

import { EmptyChatRecommendCards, pickRoleTop3 } from "./EmptyChatRecommendCards";

const mocked = vi.hoisted(() => ({
  library: null as ScenarioLibraryResponse | null,
  user: {
    position: "老板",
    preferences: { activeRoleId: "boss" },
  },
}));

vi.mock("./useScenarioLibrary", () => ({
  useScenarioLibrary: () => ({
    library: mocked.library,
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
  matchRoleIdByPosition: (roles: Array<{ id: string; name: string }>, position?: string | null) =>
    roles.find((role) => position && role.name.includes(position))?.id ?? null,
  pickRecommendedScenarios: (scenarios: ScenarioItem[], count: number) => scenarios.slice(0, count),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: mocked.user }),
}));

const bossScenario: ScenarioItem = {
  id: "boss-1",
  title: "Claude 竞品晨报",
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
};

const salesScenario: ScenarioItem = {
  ...bossScenario,
  id: "sales-1",
  title: "销售客户简报",
  role: "sales",
};

describe("EmptyChatRecommendCards", () => {
  it("renders role-first recommendations and sanitizes customer-facing text", () => {
    const onTryScenario = vi.fn();
    mocked.library = {
      roles: [
        { id: "boss", name: "老板/总经理", sort: 1 },
        { id: "sales", name: "销售", sort: 2 },
      ],
      scenarios: [salesScenario, bossScenario],
    };

    render(
      <EmptyChatRecommendCards
        onTryScenario={onTryScenario}
        onViewAll={vi.fn()}
        onOpenRoleDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("老板/总经理开箱任务")).toBeTruthy();
    expect(screen.getByText("AI 大脑 竞品晨报")).toBeTruthy();

    fireEvent.click(screen.getByText("AI 大脑 竞品晨报"));
    expect(onTryScenario).toHaveBeenCalledWith("请跟进 同行A", expect.objectContaining({ id: "boss-1" }));
  });

  it("picks top scenarios by first aha mode and recurring priority", () => {
    const picked = pickRoleTop3(
      [
        { ...bossScenario, id: "low", firstAhaMode: "voice_then_result", mode: "oneshot" },
        { ...bossScenario, id: "high", firstAhaMode: "zero_input_example", mode: "oneshot" },
        { ...bossScenario, id: "rec", firstAhaMode: "zero_input_example", mode: "recurring" },
      ],
      "boss",
    );

    expect(picked.map((item) => item.id)).toEqual(["rec", "high", "low"]);
  });
});
