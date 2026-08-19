import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ExpertWelcome } from "./ExpertWelcome";

const expert = {
  id: "expert-ops",
  name: "经营分析专家",
  description: "负责经营分析",
  starterPrompts: ["复盘经营数据", "找出回款风险", "生成例会提纲", "第四个不应首屏出现"],
  skillCount: 2,
};

describe("ExpertWelcome", () => {
  it("只展示 3 条轻量起手任务并可预填", () => {
    const onPrefill = vi.fn();
    render(<ExpertWelcome expert={expert} onPrefill={onPrefill} />);

    expect(screen.getAllByText("直接试")).toHaveLength(3);
    expect(screen.queryByText("第四个不应首屏出现")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /复盘经营数据/ }));
    expect(onPrefill).toHaveBeenCalledWith("复盘经营数据");
  });
});
