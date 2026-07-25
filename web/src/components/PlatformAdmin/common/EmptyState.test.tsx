/**
 * EmptyState 的行为契约。
 *
 * 为什么值得单测：改造前 17 个空态里只有 1 个有 CTA。这个组件存在的全部意义
 * 就是「空态必须能行动」，所以 CTA 的渲染与回调是它的核心契约，
 * 而「没传 CTA 时不凭空造按钮」同样重要（正向反馈空态不该有按钮）。
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CircleCheck, SearchX } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("渲染标题与说明", () => {
    render(<EmptyState title="没有符合条件的对话" description="放宽时间范围再试一次" />);
    expect(screen.getByText("没有符合条件的对话")).toBeTruthy();
    expect(screen.getByText("放宽时间范围再试一次")).toBeTruthy();
  });

  it("主 CTA 可点击并触发回调", async () => {
    const onClick = vi.fn();
    render(<EmptyState title="空" action={{ label: "清除全部筛选", onClick }} />);
    await userEvent.click(screen.getByRole("button", { name: "清除全部筛选" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("主 / 次 CTA 可同时存在，互不干扰", async () => {
    const primary = vi.fn();
    const secondary = vi.fn();
    render(
      <EmptyState
        title="空"
        action={{ label: "清除筛选", onClick: primary }}
        secondaryAction={{ label: "放宽到 30 天", onClick: secondary, icon: SearchX }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "放宽到 30 天" }));
    expect(secondary).toHaveBeenCalledTimes(1);
    expect(primary).not.toHaveBeenCalled();
  });

  it("不传 action 时不渲染任何按钮 —— 正向反馈空态不该有 CTA", () => {
    render(<EmptyState icon={CircleCheck} tone="positive" title="暂无待处理异常" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("tone=positive 时图标走 success 语义色而不是灰", () => {
    const { container } = render(<EmptyState icon={CircleCheck} tone="positive" title="一切正常" />);
    const icon = container.querySelector("svg");
    expect(icon?.getAttribute("class")).toContain("text-success");
  });

  it("默认 tone 的图标是中性灰，不会被误读成状态", () => {
    const { container } = render(<EmptyState icon={SearchX} title="没有结果" />);
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("text-muted-foreground/60");
  });

  it("children 槽可内嵌表单/示意图（空态即创建入口）", () => {
    render(<EmptyState title="还没有数据集"><input aria-label="数据集名称" /></EmptyState>);
    expect(screen.getByLabelText("数据集名称")).toBeTruthy();
  });

  it("compact 收窄纵向占位，用于表格内联空态", () => {
    const { container } = render(<EmptyState title="空" compact />);
    expect(container.firstElementChild?.getAttribute("class")).toContain("py-8");
  });
});
