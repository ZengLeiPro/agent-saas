/**
 * AdminEntityTable 的行为契约。
 *
 * 这张表是 platform-admin 六个列表页的唯一表格实现，本次给它加了四项**全新能力**：
 * 列排序、列显隐（+ localStorage）、行键盘可达、骨架屏。四项都没有任何既有测试，
 * 一旦回归会同时影响 6 个页面，因此逐条锁住。
 *
 * 另外锁住两条「不得弄丢的优势」：
 * - `loading && rows.length > 0` 时**不清表**（刷新不丢阅读位置）；
 * - 空值（sortValue 返回 null）在升/降序下**恒排末尾**，不会让「—」霸占第一屏。
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AdminEntityTable, type AdminEntityColumn } from "./AdminEntityTable";

interface Row {
  id: string;
  name: string;
  cost: number | null;
}

const ROWS: Row[] = [
  { id: "a", name: "乙组织", cost: 30 },
  { id: "b", name: "甲组织", cost: null },
  { id: "c", name: "丙组织", cost: 10 },
];

const COLUMNS: AdminEntityColumn<Row>[] = [
  { key: "name", header: "名称", alwaysVisible: true, sortable: true, sortValue: (row) => row.name, cell: (row) => row.name },
  {
    key: "cost",
    header: "成本",
    className: "text-right",
    sortable: true,
    sortNumeric: true,
    sortValue: (row) => row.cost,
    cell: (row) => (row.cost == null ? "—" : String(row.cost)),
  },
  { key: "note", header: "备注", cell: () => "备注文本" },
];

function bodyCells(columnIndex: number): string[] {
  const rows = screen.getAllByRole("row").slice(1); // 去掉表头行
  return rows.map((row) => within(row).getAllByRole("cell")[columnIndex]?.textContent ?? "");
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("AdminEntityTable · 排序", () => {
  it("默认不排序，保持服务端返回顺序", () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} />);
    expect(bodyCells(0)).toEqual(["乙组织", "甲组织", "丙组织"]);
  });

  it("可排序列的表头是按钮且带 aria-sort=none", () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} />);
    expect(screen.getByRole("columnheader", { name: /名称/ }).getAttribute("aria-sort")).toBe("none");
    // 不可排序列不应声明 aria-sort
    expect(screen.getByRole("columnheader", { name: "备注" }).getAttribute("aria-sort")).toBeNull();
  });

  it("字符串列首次点击升序，aria-sort 变 ascending", async () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} />);
    await userEvent.click(screen.getByRole("button", { name: /名称/ }));
    expect(bodyCells(0)).toEqual(["丙组织", "甲组织", "乙组织"]);
    expect(screen.getByRole("columnheader", { name: /名称/ }).getAttribute("aria-sort")).toBe("ascending");
  });

  it("数字列（sortNumeric）首次点击降序 —— 运维要看最大值而不是最小值", async () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} />);
    await userEvent.click(screen.getByRole("button", { name: /成本/ }));
    expect(screen.getByRole("columnheader", { name: /成本/ }).getAttribute("aria-sort")).toBe("descending");
    expect(bodyCells(1)).toEqual(["30", "10", "—"]);
  });

  it("空值在升序和降序下都排在末尾，不会让「—」霸占第一屏", async () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} />);
    const header = screen.getByRole("button", { name: /成本/ });
    await userEvent.click(header); // desc
    expect(bodyCells(1)[2]).toBe("—");
    await userEvent.click(header); // asc
    expect(bodyCells(1)).toEqual(["10", "30", "—"]);
  });

  it("第三次点击取消排序，回到服务端默认顺序", async () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} />);
    const header = screen.getByRole("button", { name: /成本/ });
    await userEvent.click(header);
    await userEvent.click(header);
    await userEvent.click(header);
    expect(bodyCells(0)).toEqual(["乙组织", "甲组织", "丙组织"]);
    expect(screen.getByRole("columnheader", { name: /成本/ }).getAttribute("aria-sort")).toBe("none");
  });

  it("defaultSort 生效", () => {
    render(
      <AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} defaultSort={{ key: "cost", direction: "asc" }} />,
    );
    expect(bodyCells(1)).toEqual(["10", "30", "—"]);
  });

  it("只写 sortable 不给 sortValue 的列不渲染排序按钮（防半成品 API）", () => {
    render(
      <AdminEntityTable
        rows={ROWS}
        rowKey={(row) => row.id}
        columns={[{ key: "name", header: "名称", sortable: true, cell: (row) => row.name }]}
      />,
    );
    expect(screen.queryByRole("button", { name: /名称/ })).toBeNull();
  });
});

describe("AdminEntityTable · 列显隐", () => {
  it("hiddenByDefault 的列初始不渲染（这个字段改造前是死 API）", () => {
    const columns = COLUMNS.map((column) => (column.key === "note" ? { ...column, hiddenByDefault: true } : column));
    render(<AdminEntityTable rows={ROWS} columns={columns} rowKey={(row) => row.id} />);
    expect(screen.queryByRole("columnheader", { name: "备注" })).toBeNull();
  });

  it("「列」下拉可以关掉一列", async () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} />);
    await userEvent.click(screen.getByRole("button", { name: "选择显示的列" }));
    await waitFor(() => expect(screen.getByRole("menuitemcheckbox", { name: "备注" })).toBeTruthy());
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "备注" }));
    await waitFor(() => expect(screen.queryByRole("columnheader", { name: "备注" })).toBeNull());
  });

  it("alwaysVisible 的列不出现在下拉里，无法被关掉", async () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} />);
    await userEvent.click(screen.getByRole("button", { name: "选择显示的列" }));
    await waitFor(() => expect(screen.getByRole("menuitemcheckbox", { name: "备注" })).toBeTruthy());
    expect(screen.queryByRole("menuitemcheckbox", { name: "名称" })).toBeNull();
  });

  it("storageKey 存在时把选择写进 localStorage，并在重挂载后恢复", async () => {
    const { unmount } = render(
      <AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} storageKey="unit-test" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "选择显示的列" }));
    await waitFor(() => expect(screen.getByRole("menuitemcheckbox", { name: "备注" })).toBeTruthy());
    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: "备注" }));

    expect(window.localStorage.getItem("admin-table:hidden-columns:unit-test")).toBe('["note"]');

    unmount();
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} storageKey="unit-test" />);
    expect(screen.queryByRole("columnheader", { name: "备注" })).toBeNull();
  });

  it("localStorage 里是脏数据时安全退回默认列集合", () => {
    window.localStorage.setItem("admin-table:hidden-columns:unit-test", "{not json");
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} storageKey="unit-test" />);
    expect(screen.getByRole("columnheader", { name: "备注" })).toBeTruthy();
  });

  it("「恢复默认」把列集合还原", async () => {
    window.localStorage.setItem("admin-table:hidden-columns:unit-test", '["note"]');
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} storageKey="unit-test" />);
    expect(screen.queryByRole("columnheader", { name: "备注" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "选择显示的列" }));
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "恢复默认" })).toBeTruthy());
    await userEvent.click(screen.getByRole("menuitem", { name: "恢复默认" }));
    await waitFor(() => expect(screen.getByRole("columnheader", { name: "备注" })).toBeTruthy());
  });

  it("columnSelector=false 时不渲染「列」按钮", () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} columnSelector={false} />);
    expect(screen.queryByRole("button", { name: "选择显示的列" })).toBeNull();
  });
});

describe("AdminEntityTable · 行键盘可达", () => {
  it("有 onRowClick 时行可聚焦，Enter 触发激活", async () => {
    const onRowClick = vi.fn();
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} onRowClick={onRowClick} />);
    const firstRow = screen.getAllByRole("row")[1];
    expect(firstRow.getAttribute("tabindex")).toBe("0");

    firstRow.focus();
    await userEvent.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
  });

  it("没有 onRowClick 时行不可聚焦（不伪造可交互）", () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} />);
    expect(screen.getAllByRole("row")[1].getAttribute("tabindex")).toBeNull();
  });

  it("selectedRowKey 给出时渲染 aria-selected 与 data-state", () => {
    render(
      <AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} onRowClick={() => {}} selectedRowKey="c" />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0].getAttribute("aria-selected")).toBe("false");
    expect(rows[2].getAttribute("aria-selected")).toBe("true");
    expect(rows[2].getAttribute("data-state")).toBe("selected");
  });

  it("不传 selectedRowKey 时不虚报 aria-selected", () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} onRowClick={() => {}} />);
    expect(screen.getAllByRole("row")[1].getAttribute("aria-selected")).toBeNull();
  });
});

describe("AdminEntityTable · 加载与空态", () => {
  it("首次加载（无数据）渲染骨架屏，列名可读，不是居中 spinner", () => {
    render(<AdminEntityTable rows={[]} columns={COLUMNS} rowKey={(row) => row.id} loading skeletonRows={4} />);
    expect(screen.getByText("正在加载数据…")).toBeTruthy();
    // 真实表头在骨架期就已渲染（结构先出、数据后填）
    expect(screen.getByRole("columnheader", { name: /名称/ })).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(5); // 表头 1 + 骨架 4
    expect(screen.queryByText("加载中...")).toBeNull();
  });

  it("刷新时（已有数据）不清表，同时给出刷新指示 —— 改造前这里完全没有反馈", () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} loading />);
    expect(bodyCells(0)).toEqual(["乙组织", "甲组织", "丙组织"]);
    expect(screen.getByText("正在刷新…")).toBeTruthy();
    expect(screen.queryByText("正在加载数据…")).toBeNull();
  });

  it("不加载时没有任何加载指示", () => {
    render(<AdminEntityTable rows={ROWS} columns={COLUMNS} rowKey={(row) => row.id} />);
    expect(screen.queryByText("正在刷新…")).toBeNull();
  });

  it("emptyText 默认渲染为 EmptyState 形态", () => {
    render(<AdminEntityTable rows={[]} columns={COLUMNS} rowKey={(row) => row.id} emptyText="暂无组织" />);
    expect(screen.getByText("暂无组织")).toBeTruthy();
  });

  it("emptyState 可带 CTA 并优先于 emptyText", async () => {
    const onClick = vi.fn();
    const { EmptyState } = await import("./EmptyState");
    render(
      <AdminEntityTable
        rows={[]}
        columns={COLUMNS}
        rowKey={(row) => row.id}
        emptyText="不该出现"
        emptyState={<EmptyState title="没有符合条件的记录" action={{ label: "清除全部筛选", onClick }} />}
      />,
    );
    expect(screen.queryByText("不该出现")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "清除全部筛选" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
