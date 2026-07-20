import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { Tenant } from "./types";

const mocked = vi.hoisted(() => ({
  authFetch: vi.fn(),
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

vi.mock("@/lib/authFetch", () => ({ authFetch: (...args: [string, RequestInit?]) => mocked.authFetch(...args) }));
vi.mock("@/lib/preload", () => ({ tenantsPreload: Promise.resolve(mocked.initialTenants) }));
vi.mock("@/lib/refreshBus", () => ({ registerRefresh: vi.fn(), unregisterRefresh: vi.fn() }));

import { useTenants } from "./hooks";

describe("useTenants", () => {
  it("排序刷新会同步所有已挂载的组织选择器实例", async () => {
    serverTenants = initialTenants;
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
});
