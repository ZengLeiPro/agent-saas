/**
 * TableSkeleton 的行为契约。
 *
 * 改造前全模块 0 个骨架屏、24 处加载态都是「居中 spinner + 加载中…」，
 * 容器高度与真实表格不一致 → 数据到达时布局抖一下。
 *
 * 两条锁死项：
 * - 骨架的行数 / 列数由 props 决定，且传入真实表头时列名可读（结构先出、数据后填）；
 * - 右对齐列的占位条也靠右 —— 数字右对齐是既有优势，骨架屏不能把它丢掉。
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TableSkeleton } from "./TableSkeleton";

describe("TableSkeleton", () => {
  it("按 rows / columns 渲染对应数量的占位单元格", () => {
    render(<TableSkeleton rows={3} columns={4} />);
    // 表头 1 行 + 数据 3 行
    expect(screen.getAllByRole("row")).toHaveLength(4);
    const bodyRows = screen.getAllByRole("row").slice(1);
    expect(within(bodyRows[0]).getAllByRole("cell")).toHaveLength(4);
  });

  it("表格带 aria-busy 与 sr-only 加载文案", () => {
    const { container } = render(<TableSkeleton label="正在加载执行记录…" />);
    expect(container.querySelector("table")?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("正在加载执行记录…")).toBeTruthy();
  });

  it("传入真实表头时列名在加载期就可读", () => {
    render(
      <TableSkeleton
        columns={2}
        header={<tr><th>名称</th><th>成本</th></tr>}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "名称" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "成本" })).toBeTruthy();
  });

  it("right 对齐的列，占位条靠右（保住数字右对齐观感）", () => {
    const { container } = render(<TableSkeleton rows={1} columns={2} align={["left", "right"]} />);
    const cells = within(container.querySelectorAll("tbody tr")[0] as HTMLElement).getAllByRole("cell");
    expect(cells[0].querySelector("div")?.getAttribute("class")).not.toContain("ml-auto");
    expect(cells[1].querySelector("div")?.getAttribute("class")).toContain("ml-auto");
  });

  it("占位宽度是确定性推导，两次渲染完全一致（不产生随机快照）", () => {
    const first = render(<TableSkeleton rows={3} columns={3} />).container.innerHTML;
    const second = render(<TableSkeleton rows={3} columns={3} />).container.innerHTML;
    expect(first).toBe(second);
  });

  it("rows / columns 传 0 时至少渲染 1 行 1 列（不塌成空表）", () => {
    render(<TableSkeleton rows={0} columns={0} />);
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });
});
