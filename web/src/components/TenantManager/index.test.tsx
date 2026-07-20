import { useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TenantListPanel } from "./index";
import type { Tenant, UserInfo } from "./types";

const tenants: Tenant[] = [
  { id: "pantheon", name: "万神殿", createdAt: "2026-07-01T01:00:00.000Z", createdBy: "system", updatedAt: "2026-07-01T01:00:00.000Z" },
  { id: "wain", name: "唯恩电气", createdAt: "2026-07-02T01:00:00.000Z", createdBy: "admin", updatedAt: "2026-07-03T01:00:00.000Z" },
  { id: "acme", name: "阿康", createdAt: "2026-07-04T01:00:00.000Z", createdBy: "admin", updatedAt: "2026-07-05T01:00:00.000Z", disabled: true },
];

function Harness({ onReorder }: { onReorder: (ids: string[]) => Promise<void> }) {
  const [actions, setActions] = useState<ReactNode | null>(null);
  const usersByTenant = new Map<string, UserInfo[]>([
    ["wain", [{} as UserInfo, {} as UserInfo]],
  ]);
  return (
    <>
      <div>{actions}</div>
      <TenantListPanel
        tenants={tenants}
        usersByTenant={usersByTenant}
        canReorder
        platformReadOnly={false}
        onReorder={onReorder}
        onToggleDisabled={vi.fn()}
        onDelete={vi.fn()}
        onActionsChange={setActions}
      />
    </>
  );
}

describe("TenantListPanel", () => {
  it("展示单行组织表格、成员数与状态操作", () => {
    render(<Harness onReorder={vi.fn(async () => undefined)} />);

    expect(screen.getByRole("columnheader", { name: "组织名称" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Slug" })).toBeTruthy();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows.every(row => row.className.includes("whitespace-nowrap"))).toBe(true);
    expect(within(rows[1]!).getByText("2")).toBeTruthy();
    expect(within(rows[2]!).getByText("已禁用")).toBeTruthy();
    expect(within(rows[0]!).getByRole("button", { name: "删除" }).hasAttribute("disabled")).toBe(true);
  });

  it("支持键盘调整顺序并把完整顺序交给保存接口", async () => {
    const onReorder = vi.fn(async () => undefined);
    render(<Harness onReorder={onReorder} />);

    fireEvent.keyDown(screen.getByRole("button", { name: "调整组织 唯恩电气 的顺序" }), { key: "ArrowUp" });
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows.map(row => within(row).getAllByRole("cell")[1]?.textContent)).toEqual(["唯恩电气", "万神殿", "阿康"]);
    expect(screen.getByText("排序未保存")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存排序" }));
    });
    expect(onReorder).toHaveBeenCalledWith(["wain", "pantheon", "acme"]);
  });
});
