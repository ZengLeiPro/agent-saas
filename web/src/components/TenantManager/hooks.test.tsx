import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Tenant } from "./types";

const mocked = vi.hoisted(() => ({
  authFetch: vi.fn(),
  createTenant: vi.fn(),
  previewTenantLifecycle: vi.fn(),
  updateTenantLifecycle: vi.fn(),
  previewTenantDelete: vi.fn(),
  startTenantDelete: vi.fn(),
  initialTenants: [
    { id: "pantheon", name: "万神殿", createdAt: "2026-07-01", createdBy: "system", updatedAt: "2026-07-01" },
    { id: "wain", name: "唯恩", createdAt: "2026-07-02", createdBy: "admin", updatedAt: "2026-07-02" },
  ],
}));

const initialTenants = mocked.initialTenants as Tenant[];
let serverTenants = initialTenants;
mocked.authFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
  if (init?.method === "PATCH") {
    const { ids } = JSON.parse(String(init.body)) as { ids: string[] };
    const byId = new Map(serverTenants.map(tenant => [tenant.id, tenant]));
    serverTenants = ids.map(id => byId.get(id)!);
    return new Response(JSON.stringify({ tenants: serverTenants }), { status: 200 });
  }
  return new Response(JSON.stringify({ tenants: serverTenants }), { status: 200 });
});

vi.mock("@agent/shared/lib/governanceApi", () => ({
  governanceAccessApi: {
    createTenant: (...args: unknown[]) => mocked.createTenant(...args),
    previewTenantLifecycle: (...args: unknown[]) => mocked.previewTenantLifecycle(...args),
    updateTenantLifecycle: (...args: unknown[]) => mocked.updateTenantLifecycle(...args),
  },
  governanceResourcesApi: {
    previewTenantDelete: (...args: unknown[]) => mocked.previewTenantDelete(...args),
    startTenantDelete: (...args: unknown[]) => mocked.startTenantDelete(...args),
  },
}));
vi.mock("@/lib/authFetch", () => ({ authFetch: (...args: [string, RequestInit?]) => mocked.authFetch(...args) }));
vi.mock("@/lib/preload", () => ({ tenantsPreload: Promise.resolve(mocked.initialTenants) }));
vi.mock("@/lib/refreshBus", () => ({ registerRefresh: vi.fn(), unregisterRefresh: vi.fn() }));

import { useTenants } from "./hooks";

describe("useTenants", () => {
  it("排序刷新会同步所有已挂载的组织选择器实例", async () => {
    serverTenants = initialTenants;
    mocked.authFetch.mockClear();
    mocked.createTenant.mockReset();
    const { result } = renderHook(() => ({ first: useTenants(), second: useTenants() }));
    await waitFor(() => expect(result.current.first.tenants.map(tenant => tenant.id)).toEqual(["pantheon", "wain"]));
    await waitFor(() => expect(result.current.second.tenants.map(tenant => tenant.id)).toEqual(["pantheon", "wain"]));

    await act(async () => {
      await result.current.first.reorderTenants(["wain", "pantheon"]);
    });

    expect(result.current.first.tenants.map(tenant => tenant.id)).toEqual(["wain", "pantheon"]);
    expect(result.current.second.tenants.map(tenant => tenant.id)).toEqual(["wain", "pantheon"]);
    expect(mocked.authFetch).toHaveBeenCalledWith("/api/tenants", expect.objectContaining({ method: "PATCH" }));
  });

  it("创建组织改走治理 API，并在成功后刷新组织列表", async () => {
    serverTenants = initialTenants;
    mocked.authFetch.mockClear();
    mocked.createTenant.mockReset();
    mocked.createTenant.mockImplementationOnce(async (input: { id: string; name: string }) => {
      serverTenants = [...serverTenants, {
        ...input,
        createdAt: "2026-08-14",
        createdBy: "platform-1",
        updatedAt: "2026-08-14",
      } as Tenant];
    });
    const { result } = renderHook(() => useTenants());

    await act(async () => {
      await result.current.createTenant({ id: "test-org", name: "测试组织" });
    });

    expect(mocked.createTenant).toHaveBeenCalledWith({ id: "test-org", name: "测试组织" });
    expect(result.current.tenants.map(tenant => tenant.id)).toContain("test-org");
    expect(mocked.authFetch).not.toHaveBeenCalledWith(
      "/api/tenants",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("启停组织通过生命周期预览与提交，不再调用旧 status 路由", async () => {
    serverTenants = initialTenants;
    mocked.authFetch.mockClear();
    mocked.previewTenantLifecycle.mockReset().mockResolvedValue({
      previewId: "preview-1",
      baselineDigest: "digest-1",
      expiresAt: "2026-08-16T08:00:00.000Z",
      impact: { blockers: [] },
    });
    mocked.updateTenantLifecycle.mockReset().mockResolvedValue({ status: "suspended" });
    const { result } = renderHook(() => useTenants());

    await act(async () => {
      await result.current.setTenantDisabled("wain", true);
    });

    expect(mocked.previewTenantLifecycle).toHaveBeenCalledWith("wain", {
      action: "suspend",
      reason: "平台组织管理暂停组织",
    });
    expect(mocked.updateTenantLifecycle).toHaveBeenCalledWith("wain", expect.objectContaining({
      action: "suspend",
      previewId: "preview-1",
    }));
    expect(mocked.authFetch).not.toHaveBeenCalledWith(
      "/api/tenants/wain/status",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("删除组织通过预览与 Change Job，不再调用旧 DELETE 路由", async () => {
    serverTenants = initialTenants;
    mocked.authFetch.mockClear();
    mocked.previewTenantDelete.mockReset().mockResolvedValue({
      previewId: "delete-preview-1",
      baselineDigest: "delete-digest-1",
      expiresAt: "2026-08-16T08:00:00.000Z",
      blockers: [],
    });
    mocked.startTenantDelete.mockReset().mockResolvedValue({ jobId: "job-1" });
    const { result } = renderHook(() => useTenants());

    await act(async () => {
      await result.current.deleteTenant("wain", "wain");
    });

    expect(mocked.previewTenantDelete).toHaveBeenCalledWith({
      tenantId: "wain",
      confirm: "wain",
      reasonCode: "platform_admin_confirmed",
    });
    expect(mocked.startTenantDelete).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "wain",
      previewId: "delete-preview-1",
    }));
    expect(mocked.authFetch).not.toHaveBeenCalledWith(
      "/api/tenants/wain",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

});
