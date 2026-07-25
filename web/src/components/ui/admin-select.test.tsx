/**
 * AdminSelect 的行为契约测试。
 *
 * 为什么值得单测：这个组件一次性替换了 25 个裸 `<select>` 调用点，而那些调用点
 * 大量使用 `value=""` 表示「全部/不限」。Radix Select 恰好禁止 `value=""`
 * （空串被它当作「清空选择」），所以组件内部做了 sentinel 编解码。
 * 这层转换一旦回归，25 个筛选器的「全部」会同时静默失效——必须锁住。
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminSelect, allOption } from "./admin-select";

const OPTIONS = [allOption(), { value: "active", label: "运行中" }, { value: "failed", label: "已失败" }];

describe("AdminSelect", () => {
  it('value="" 时显示「全部」而不是占位符或空白', () => {
    render(<AdminSelect value="" onValueChange={() => {}} options={OPTIONS} ariaLabel="状态" />);
    // 空值是合法业务值（全部），不能退化成 placeholder
    expect(screen.getByLabelText("状态").textContent).toContain("全部");
  });

  it("选中非空值时正常回显", () => {
    render(<AdminSelect value="failed" onValueChange={() => {}} options={OPTIONS} ariaLabel="状态" />);
    expect(screen.getByLabelText("状态").textContent).toContain("已失败");
  });

  it("选中「全部」时回调收到的是空串，而不是内部 sentinel", async () => {
    const onValueChange = vi.fn();
    render(<AdminSelect value="failed" onValueChange={onValueChange} options={OPTIONS} ariaLabel="状态" />);

    await userEvent.click(screen.getByLabelText("状态"));
    await waitFor(() => expect(screen.getByRole("option", { name: "全部" })).toBeTruthy());
    await userEvent.click(screen.getByRole("option", { name: "全部" }));

    // 关键断言：调用点拿到的必须是 ""，sentinel 不能泄漏出组件边界
    expect(onValueChange).toHaveBeenCalledWith("");
    expect(onValueChange).not.toHaveBeenCalledWith(expect.stringContaining("sentinel"));
    expect(onValueChange).not.toHaveBeenCalledWith(expect.stringContaining("__admin_select"));
  });

  it("选中普通值时按原值回调", async () => {
    const onValueChange = vi.fn();
    render(<AdminSelect value="" onValueChange={onValueChange} options={OPTIONS} ariaLabel="状态" />);

    await userEvent.click(screen.getByLabelText("状态"));
    await waitFor(() => expect(screen.getByRole("option", { name: "运行中" })).toBeTruthy());
    await userEvent.click(screen.getByRole("option", { name: "运行中" }));

    expect(onValueChange).toHaveBeenCalledWith("active");
  });

  it("disabled 时不可展开", async () => {
    const onValueChange = vi.fn();
    render(<AdminSelect value="" onValueChange={onValueChange} options={OPTIONS} ariaLabel="状态" disabled />);

    await userEvent.click(screen.getByLabelText("状态"));
    expect(screen.queryByRole("option")).toBeNull();
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it("渲染出全部选项，逐项 disabled 生效", async () => {
    render(
      <AdminSelect
        value=""
        onValueChange={() => {}}
        options={[allOption(), { value: "a", label: "甲" }, { value: "b", label: "乙", disabled: true }]}
        ariaLabel="状态"
      />,
    );

    await userEvent.click(screen.getByLabelText("状态"));
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    expect(screen.getByRole("option", { name: "乙" }).getAttribute("data-disabled")).not.toBeNull();
  });

  it("allOption 可自定义文案，默认为「全部」", () => {
    expect(allOption()).toEqual({ value: "", label: "全部" });
    expect(allOption("全部组织")).toEqual({ value: "", label: "全部组织" });
  });
});
