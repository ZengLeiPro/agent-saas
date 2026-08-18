import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createTenant: vi.fn(),
  updateTenant: vi.fn(),
  tenantOverview: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ canPlatform: () => true }),
}));

vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({
    createTenant: mocked.createTenant,
    updateTenant: mocked.updateTenant,
  }),
}));

vi.mock("../api", () => ({
  platformAdminApi: {
    tenantOverview: mocked.tenantOverview,
  },
}));

import { TenantsPage } from "./TenantsPage";

describe("TenantsPage 创建组织入口", () => {
  beforeEach(() => {
    mocked.createTenant.mockReset();
    mocked.updateTenant.mockReset();
    mocked.tenantOverview.mockReset();
  });

  it("在组织主页面直接打开现有表单，创建成功后刷新列表", async () => {
    mocked.createTenant.mockResolvedValue(undefined);
    mocked.tenantOverview
      .mockResolvedValueOnce({ items: [], generatedAt: "2026-08-13T08:00:00.000Z" })
      .mockResolvedValue({
        items: [{
          id: "test-org",
          name: "测试组织",
          disabled: false,
          userCount: 0,
          adminCount: 0,
          activeRuns: 0,
          sessions7d: 0,
          costYuan30d: 0,
          balanceCredits: null,
          lastActiveAt: null,
        }],
        generatedAt: "2026-08-13T08:01:00.000Z",
      });

    render(<TenantsPage tenantId={null} />);

    await waitFor(() => expect(mocked.tenantOverview).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole("button", { name: "新建组织" })[0]!);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Slug（建后不可改）"), { target: { value: "test-org" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "测试组织" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(mocked.createTenant).toHaveBeenCalledWith({ id: "test-org", name: "测试组织" }));
    await waitFor(() => expect(mocked.tenantOverview).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("测试组织")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("接口失败时保留表单并显示服务端错误", async () => {
    mocked.createTenant.mockRejectedValue(new Error("tenant id 已存在"));
    mocked.tenantOverview.mockResolvedValue({ items: [], generatedAt: "2026-08-13T08:00:00.000Z" });

    render(<TenantsPage tenantId={null} />);

    await waitFor(() => expect(mocked.tenantOverview).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole("button", { name: "新建组织" })[0]!);
    fireEvent.change(screen.getByLabelText("Slug（建后不可改）"), { target: { value: "test-org" } });
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "测试组织" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByText("tenant id 已存在")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(mocked.tenantOverview).toHaveBeenCalledTimes(1);
  });

  it("组织配置先选择目标组织，再进入正式治理配置", async () => {
    mocked.tenantOverview.mockResolvedValue({
      items: [{
        id: "test-org",
        name: "测试组织",
        disabled: false,
        userCount: 2,
        adminCount: 1,
        activeRuns: 0,
        sessions7d: 3,
        costYuan30d: 0,
        balanceCredits: null,
        lastActiveAt: null,
      }],
      generatedAt: "2026-08-13T08:00:00.000Z",
    });
    window.history.replaceState({}, "", "/platform-console/org-business/tenants");

    render(<TenantsPage tenantId={null} />);

    await waitFor(() => expect(mocked.tenantOverview).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "组织配置" }));

    expect(await screen.findByRole("dialog", { name: "组织配置" })).toBeTruthy();
    expect(screen.getByText(/进入正式治理配置，可管理平台级能力授权/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "配置组织 测试组织" }));

    expect(window.location.pathname).toBe("/platform-console/org-business/tenants/test-org/configuration");
  });
});
