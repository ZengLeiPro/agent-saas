import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { saveSelection, refresh, importPersonalSkillPackage } = vi.hoisted(() => ({
  saveSelection: vi.fn(),
  refresh: vi.fn(),
  importPersonalSkillPackage: vi.fn(),
}));

vi.mock("./hooks", () => {
  const data = {
      poolSkills: [{ id: "platform-analysis", name: "平台分析", description: "平台统一提供的数据分析能力", selected: false, selectionVersion: 0, source: "pool" }],
      tenantSkills: [{ id: "org-crm", name: "组织 CRM", description: "组织内部 CRM 能力", selected: false, selectionVersion: 0, source: "tenant" }],
      customSkills: [{ id: "my-report", name: "我的周报", description: "个人创建的周报能力", selected: true, selectionVersion: 1, source: "custom" }],
  };
  return {
    useMySkills: () => ({
      data,
    loading: false,
    error: null,
    saving: false,
    saveSelection,
    refresh,
    }),
  };
});

vi.mock("@agent/shared/lib/governanceApi", () => ({
  governanceResourcesApi: { importPersonalSkillPackage },
}));

vi.mock("@agent/shared", () => ({
  deleteMySkill: vi.fn(),
  importMySkill: vi.fn(),
  SkillSelectionConflictError: class SkillSelectionConflictError extends Error {
    constructor() {
      super("技能选择已在其他页面更新，已同步最新状态，请重试");
    }
  },
}));

import { SkillSelectionConflictError } from "@agent/shared";
import { SkillSelector } from "./index";

describe("SkillSelector 能力目录", () => {
  beforeEach(() => {
    saveSelection.mockReset().mockResolvedValue(undefined);
    refresh.mockReset().mockResolvedValue(undefined);
    importPersonalSkillPackage.mockReset();
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
      expect(saveSelection).toHaveBeenCalledWith("platform-analysis", true);
    });
  });

  it("请求处理中快速连续点击只发送一次更新", async () => {
    let release!: () => void;
    saveSelection.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
    render(<SkillSelector headerTitle="我的通用 Agent 技能" />);

    fireEvent.click(await screen.findByRole("button", { name: "启用 平台分析" }));
    fireEvent.click(screen.getByRole("button", { name: "停用 平台分析" }));
    expect(saveSelection).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(screen.queryByText("技能已启用")).toBeTruthy());
  });

  it("并发冲突显示可恢复提示", async () => {
    saveSelection.mockRejectedValue(new SkillSelectionConflictError());
    render(<SkillSelector headerTitle="我的通用 Agent 技能" />);

    fireEvent.click(await screen.findByRole("button", { name: "启用 平台分析" }));
    expect(await screen.findByText("技能选择已在其他页面更新，已同步最新状态，请重试")).toBeTruthy();
  });

  it("个人 Skill 导入展示上传限制、使用治理入口并展示发布版本", async () => {
    importPersonalSkillPackage.mockResolvedValue({ ok: true, status: "succeeded", selected: true, auditCompletion: "pending", skill: { id: "personal-tool", name: "个人工具", description: "个人治理技能" }, resource: { skillId: "personal-hash", tenantId: "tenant-a", scope: "personal", ownerUserId: "user-1", status: "published", currentVersionId: "skillv-1", revision: 2, createdBy: "user-1" }, version: { versionId: "skillv-1", skillId: "personal-hash", versionNumber: 1, digest: "digest-1" } });
    const { container } = render(<SkillSelector headerTitle="我的通用 Agent 技能" />);
    fireEvent.click(screen.getByRole("button", { name: "导入技能" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/最多 300 个文件（zip 目录不计）/)).toBeTruthy();
    const input = container.querySelector('input[accept=".md,text/markdown"]') as HTMLInputElement;
    const file = new File(["---\nname: personal-tool\ndescription: personal\n---"], "SKILL.md", { type: "text/markdown" });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(importPersonalSkillPackage).toHaveBeenCalledWith([file]));
    expect(await screen.findByText("已导入并发布技能：个人工具（v1，审计记录同步中）")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });

  it("个人 Skill 导入失败后关闭导入弹框并展示错误", async () => {
    importPersonalSkillPackage.mockRejectedValue(new Error("SKILL.md 缺少 description"));
    const { container } = render(<SkillSelector headerTitle="我的通用 Agent 技能" />);
    fireEvent.click(screen.getByRole("button", { name: "导入技能" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    const input = container.querySelector('input[accept=".md,text/markdown"]') as HTMLInputElement;
    const file = new File(["---\nname: invalid\n---"], "SKILL.md", { type: "text/markdown" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText("导入失败：SKILL.md 缺少 description")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("个人 Skill 发布成功但自动启用失败时提示手动启用", async () => {
    importPersonalSkillPackage.mockResolvedValue({ ok: true, status: "succeeded", selected: false, skill: { id: "manual-enable", name: "手动启用技能", description: "个人治理技能" }, resource: { skillId: "personal-hash", tenantId: "tenant-a", scope: "personal", ownerUserId: "user-1", status: "published", currentVersionId: "skillv-1", revision: 2, createdBy: "user-1" }, version: { versionId: "skillv-1", skillId: "personal-hash", versionNumber: 1, digest: "digest-1" } });
    const { container } = render(<SkillSelector headerTitle="我的通用 Agent 技能" />);
    const input = container.querySelector('input[accept=".md,text/markdown"]') as HTMLInputElement;
    const file = new File(["---\nname: manual-enable\ndescription: personal\n---"], "SKILL.md", { type: "text/markdown" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByText(/但未能自动启用，请在列表中手动启用/)).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it("支持来源筛选和关键词搜索", async () => {
    render(<SkillSelector headerTitle="我的通用 Agent 技能" />);
    expect(await screen.findByText("平台分析")).toBeTruthy();

    const filters = screen.getByLabelText("能力来源筛选");
    const organizationFilter = within(filters).getByRole("tab", { name: /组织提供/ });
    fireEvent.click(organizationFilter);
    expect(organizationFilter.className).toContain("rounded-full");
    expect(organizationFilter.className).toContain("border-transparent");
    expect(organizationFilter.className).toContain("bg-primary");
    expect(organizationFilter.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("组织 CRM")).toBeTruthy();
    expect(screen.queryByText("平台分析")).toBeNull();

    fireEvent.click(within(filters).getByRole("tab", { name: /全部/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索技能名称或描述" }), { target: { value: "周报" } });
    expect(screen.getByText("我的周报")).toBeTruthy();
    expect(screen.queryByText("组织 CRM")).toBeNull();
  });
});
