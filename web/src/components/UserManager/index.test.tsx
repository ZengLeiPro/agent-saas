import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UserManager } from "./index";

const mocks = vi.hoisted(() => ({
  createUser: vi.fn(),
  updateUser: vi.fn(),
  deleteUser: vi.fn(),
  toggleUserDisabled: vi.fn(),
  navigateGovernance: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "admin-1" } }),
}));

vi.mock("@/hooks/useIsMobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/lib/urlSync", () => ({
  navigateGovernance: mocks.navigateGovernance,
}));

vi.mock("./hooks", () => ({
  useUsers: () => ({
    users: [],
    loading: false,
    error: null,
    createUser: mocks.createUser,
    updateUser: mocks.updateUser,
    deleteUser: mocks.deleteUser,
    toggleUserDisabled: mocks.toggleUserDisabled,
  }),
}));

vi.mock("./UserTable", () => ({ UserTable: () => <div>用户列表</div> }));
vi.mock("./UserFormDialog", () => ({ UserFormDialog: () => null }));
vi.mock("./DeleteUserDialog", () => ({ DeleteUserDialog: () => null }));
vi.mock("./LoginLogDialog", () => ({ LoginLogDialog: () => null }));
vi.mock("./ResetUserPasswordDialog", () => ({ ResetUserPasswordDialog: () => null }));

describe("UserManager 新增成员入口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("锁定当前组织并跳转治理成员页，不调用旧版用户写接口", () => {
    render(<UserManager tenantIdScope="tenant-a" tenantName="客户甲" />);

    fireEvent.click(screen.getByRole("button", { name: "添加成员" }));

    expect(mocks.navigateGovernance).toHaveBeenCalledWith(expect.objectContaining({
      routeId: "organization.members.list",
      orgId: "tenant-a",
    }));
    expect(mocks.createUser).not.toHaveBeenCalled();
  });

  it("未明确目标组织时不展示新增入口", () => {
    render(<UserManager />);

    expect(screen.queryByRole("button", { name: /添加成员|新建用户/ })).toBeNull();
    expect(mocks.createUser).not.toHaveBeenCalled();
  });
});
