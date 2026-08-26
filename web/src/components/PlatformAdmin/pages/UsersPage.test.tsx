import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  users: vi.fn(),
}));

vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({
    tenants: [
      { id: "pantheon", name: "万神殿" },
      { id: "acme", name: "Acme" },
      { id: "beta", name: "Beta" },
    ],
  }),
}));

vi.mock("../api", () => ({
  platformAdminApi: {
    users: mocks.users,
  },
}));

import { UsersPage } from "./UsersPage";

describe("UsersPage 添加成员入口", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/platform-console/org-business/users");
    mocks.users.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  });

  it("必须选择客户组织后才进入精确绑定 org 的治理成员页", async () => {
    render(<UsersPage userId={null} />);

    const openPicker = await screen.findByRole("button", { name: "选择组织并添加成员" });
    await userEvent.click(openPicker);

    const dialog = screen.getByRole("dialog", { name: "选择添加成员的目标组织" });
    expect(within(dialog).getByText(/必须明确选择客户组织/)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "进入成员治理页" }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(within(dialog).getByRole("combobox", { name: "添加成员的目标组织" }));
    expect(screen.queryByRole("option", { name: "万神殿" })).toBeNull();
    await userEvent.click(screen.getByRole("option", { name: "Acme" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "进入成员治理页" }));

    await waitFor(() => expect(window.location.pathname).toBe("/tenant-admin/members/list"));
    expect(window.location.search).toBe("?org=acme");
  });
});
