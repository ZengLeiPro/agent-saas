/**
 * ActiveFilterBar 的行为契约。
 *
 * 提取自 `RunTraceExplorer/RunListView.tsx` 原有的 FilterChip 实现。审计确认
 * 这套「组织：开沿科技」的中文键值形态比对标产品的查询 DSL 更可读，**这是我们的优势**，
 * 因此测试直接把「标签原文可读」「每个删除按钮有可读 aria-label」锁进契约，
 * 防止后续有人把它改成 `tenant = xxx` 那种形态。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ActiveFilterBar } from "./ActiveFilterBar";

describe("ActiveFilterBar", () => {
  it("条件为空时整条不渲染，不占位把工具栏顶高", () => {
    const { container } = render(<ActiveFilterBar items={[]} onClearAll={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("逐条渲染中文键值标签", () => {
    render(
      <ActiveFilterBar
        items={[
          { key: "tenantId", label: "组织：开沿科技", onRemove: () => {} },
          { key: "status", label: "状态：失败或取消", onRemove: () => {} },
        ]}
      />,
    );
    expect(screen.getByText("组织：开沿科技")).toBeTruthy();
    expect(screen.getByText("状态：失败或取消")).toBeTruthy();
    expect(screen.getByText("筛选生效中")).toBeTruthy();
  });

  it("逐条删除只触发对应那一条的 onRemove", async () => {
    const removeTenant = vi.fn();
    const removeStatus = vi.fn();
    render(
      <ActiveFilterBar
        items={[
          { key: "tenantId", label: "组织：开沿科技", onRemove: removeTenant },
          { key: "status", label: "状态：失败或取消", onRemove: removeStatus },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "移除筛选：状态：失败或取消" }));
    expect(removeStatus).toHaveBeenCalledTimes(1);
    expect(removeTenant).not.toHaveBeenCalled();
  });

  it("一键清除全部", async () => {
    const onClearAll = vi.fn();
    render(
      <ActiveFilterBar items={[{ key: "a", label: "组织：甲", onRemove: () => {} }]} onClearAll={onClearAll} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "清除全部" }));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("不传 onClearAll 时不渲染「清除全部」", () => {
    render(<ActiveFilterBar items={[{ key: "a", label: "组织：甲", onRemove: () => {} }]} />);
    expect(screen.queryByRole("button", { name: "清除全部" })).toBeNull();
  });

  it("label 可自定义（不同页面口径不同）", () => {
    render(<ActiveFilterBar label="当前条件" items={[{ key: "a", label: "组织：甲", onRemove: () => {} }]} />);
    expect(screen.getByText("当前条件")).toBeTruthy();
  });
});
