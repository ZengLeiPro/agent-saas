import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveSelections, refresh } = vi.hoisted(() => ({
  saveSelections: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("./hooks", () => {
  const data = {
      poolSkills: [{ id: "platform-analysis", name: "平台分析", description: "平台统一提供的数据分析能力", selected: false, source: "pool" }],
      tenantSkills: [{ id: "org-crm", name: "组织 CRM", description: "组织内部 CRM 能力", selected: false, source: "tenant" }],
      customSkills: [{ id: "my-report", name: "我的周报", description: "个人创建的周报能力", selected: true, source: "custom" }],
  };
  return {
    useMySkills: () => ({
      data,
    loading: false,
    error: null,
    saving: false,
    saveSelections,
    refresh,
    }),
  };
});

vi.mock("@agent/shared", () => ({
  deleteMySkill: vi.fn(),
  importMySkill: vi.fn(),
}));

import { SkillSelector } from "./index";

describe("SkillSelector 能力目录", () => {
  beforeEach(() => {
    saveSelections.mockReset().mockResolvedValue(undefined);
    refresh.mockReset().mockResolvedValue(undefined);
  });

  it("统一展示三层来源，并在卡片上即时启用技能", async () => {
    render(<SkillSelector headerTitle="我的通用 Agent 技能" />);

    expect(await screen.findByText("平台分析")).toBeTruthy();
    expect(screen.getByText("组织 CRM")).toBeTruthy();
    expect(screen.getByText("我的周报")).toBeTruthy();
    expect(screen.getAllByText("平台提供").length).toBeGreaterThan(0);
    expect(screen.getAllByText("组织提供").length).toBeGreaterThan(0);
    expect(screen.getAllByText("我创建的").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "启用 平台分析" }));
    await waitFor(() => {
      expect(saveSelections).toHaveBeenCalledWith(["platform-analysis", "my-report"]);
    });
  });

  it("支持来源筛选和关键词搜索", async () => {
    render(<SkillSelector headerTitle="我的通用 Agent 技能" />);
    expect(await screen.findByText("平台分析")).toBeTruthy();

    const filters = screen.getByLabelText("能力来源筛选");
    fireEvent.click(within(filters).getByRole("button", { name: /组织提供/ }));
    expect(screen.getByText("组织 CRM")).toBeTruthy();
    expect(screen.queryByText("平台分析")).toBeNull();

    fireEvent.click(within(filters).getByRole("button", { name: /全部/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "搜索技能名称或描述" }), { target: { value: "周报" } });
    expect(screen.getByText("我的周报")).toBeTruthy();
    expect(screen.queryByText("组织 CRM")).toBeNull();
  });
});
