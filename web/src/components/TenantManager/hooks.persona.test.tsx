import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  let resolvePreload!: (value: unknown[] | null) => void;
  const tenantsPreload = new Promise<unknown[] | null>((resolve) => { resolvePreload = resolve; });
  return { authFetch: vi.fn(), tenantsPreload, resolvePreload };
});

vi.mock("@/lib/authFetch", () => ({ authFetch: (...args: unknown[]) => mocked.authFetch(...args) }));
vi.mock("@/lib/preload", () => ({ tenantsPreload: mocked.tenantsPreload }));
vi.mock("@/lib/refreshBus", () => ({ registerRefresh: vi.fn(), unregisterRefresh: vi.fn() }));

import { useTenants } from "./hooks";

describe("useTenants persona preload gate", () => {
  it("组织管理员并发挂载时共享 preload 判定且永不请求平台 /api/tenants", async () => {
    const { result } = renderHook(() => ({ first: useTenants(), second: useTenants() }));

    expect(mocked.authFetch).not.toHaveBeenCalled();
    await act(async () => { mocked.resolvePreload(null); });
    await waitFor(() => {
      expect(result.current.first.loading).toBe(false);
      expect(result.current.second.loading).toBe(false);
    });
    expect(mocked.authFetch).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.all([result.current.first.refresh(), result.current.second.refresh()]);
    });
    expect(mocked.authFetch).not.toHaveBeenCalled();
  });
});
