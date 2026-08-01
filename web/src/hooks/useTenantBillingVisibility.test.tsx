import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { useTenantBillingSummary, useTenantBillingVisibility } from "./useTenantBillingVisibility";

vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn(),
}));

describe("useTenantBillingVisibility", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("组织启用积分计费时显示入口", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      summary: { billingEnabled: true, billingMode: "prepaid" },
    }), { status: 200 }));

    const { result } = renderHook(() => useTenantBillingVisibility("tenant-1"));

    await waitFor(() => expect(result.current).toBe(true));
  });

  it("返回账户积分余额与计费模式", async () => {
    const summary = { balanceCredits: 300, billingEnabled: true, billingMode: "prepaid" };
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({ summary }), { status: 200 }));

    const { result } = renderHook(() => useTenantBillingSummary("tenant-1"));

    await waitFor(() => expect(result.current).toEqual(summary));
  });

  it.each([
    { billingEnabled: false, billingMode: "prepaid" },
    { billingEnabled: true, billingMode: "internal" },
  ])("组织不使用积分时隐藏入口：%o", async (summary) => {
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({ summary }), { status: 200 }));

    const { result } = renderHook(() => useTenantBillingVisibility("tenant-1"));

    await waitFor(() => expect(result.current).toBe(false));
  });
});
