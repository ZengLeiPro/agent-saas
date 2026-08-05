import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "admin-1", tenantId: "tenant-1" },
    isPlatformAdmin: false,
    isSuperAdmin: false,
  }),
}));

vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({ tenants: [] }),
}));

import { UserFormDialog } from "./UserFormDialog";
import type { UserInfo } from "./types";

const editingUser = {
  id: "user-1",
  username: "alice",
  role: "user",
  realName: "Alice",
  position: "销售",
  tenantId: "tenant-1",
  createdAt: "2026-08-05T00:00:00.000Z",
} as UserInfo;

describe("UserFormDialog", () => {
  it("编辑用户时岗位和角色下拉可点击选择且显示在 Dialog 之上", async () => {
    const user = userEvent.setup();
    render(
      <UserFormDialog
        open
        onOpenChange={vi.fn()}
        editingUser={editingUser}
        onSubmit={vi.fn()}
      />,
    );

    const dialog = screen.getByRole("dialog");
    const comboboxes = within(dialog).getAllByRole("combobox");
    expect(comboboxes).toHaveLength(2);

    await user.click(comboboxes[0]);
    const positionList = screen.getByRole("listbox");
    expect(positionList.className).toContain("z-[102]");
    await user.click(screen.getByRole("option", { name: "财务" }));
    expect(comboboxes[0].textContent).toContain("财务");

    await user.click(comboboxes[1]);
    const roleList = screen.getByRole("listbox");
    expect(roleList.className).toContain("z-[102]");
    await user.click(screen.getByRole("option", { name: "管理员" }));
    expect(comboboxes[1].textContent).toContain("管理员");
  });
});
