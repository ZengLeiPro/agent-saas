import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const debugPolicy = vi.hoisted(() => ({ allowed: true, enabled: true }));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "admin-1",
      tenantId: "tenant-1",
      tenantFeatures: {
        debugModeAllowed: debugPolicy.allowed,
        debugModeEnabled: debugPolicy.enabled,
      },
    },
    isPlatformAdmin: false,
    isSuperAdmin: false,
  }),
}));

vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({ tenants: [], loading: false }),
}));

import { UserFormDialog } from "./UserFormDialog";
import { SettingsDirtyBoundary } from "@/components/PersonalSettings/dirtyRegistry";
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

afterEach(() => {
  debugPolicy.allowed = true;
  debugPolicy.enabled = true;
});

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

  it("任一上级关闭时隐藏成员调试模式", () => {
    debugPolicy.enabled = false;

    render(
      <UserFormDialog
        open
        onOpenChange={vi.fn()}
        editingUser={{ ...editingUser, debugMode: true }}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.queryByRole("switch", { name: "调试模式" })).toBeNull();
  });

  it("平台与组织均开启时显示成员调试模式", () => {
    render(
      <UserFormDialog
        open
        onOpenChange={vi.fn()}
        editingUser={editingUser}
        onSubmit={vi.fn()}
      />,
    );

    expect(screen.getByRole("switch", { name: "调试模式" })).not.toBeNull();
  });

  it("账号表单有草稿时阻止设置导航", async () => {
    const user = userEvent.setup();
    let requestNavigation!: (navigation: () => void) => void;
    render(
      <SettingsDirtyBoundary>
        {(controller) => {
          requestNavigation = controller.requestNavigation;
          return (
            <UserFormDialog
              open
              onOpenChange={vi.fn()}
              editingUser={editingUser}
              onSubmit={vi.fn()}
            />
          );
        }}
      </SettingsDirtyBoundary>,
    );

    await user.clear(screen.getByLabelText("真实姓名"));
    await user.type(screen.getByLabelText("真实姓名"), "新的姓名");
    await act(async () => requestNavigation(vi.fn()));

    expect(await screen.findByRole("heading", { name: "有未保存的更改" })).toBeTruthy();
    expect(screen.getByText(/编辑账号 alice尚未保存/)).toBeTruthy();
  });
});
