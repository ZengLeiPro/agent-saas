import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import {
  resolveBillingAllowance,
  useMyMemberBudget,
  useTenantBillingSummary,
  useTenantBillingVisibility,
} from "./useTenantBillingVisibility";

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

  it("读取当前用户的个人预算", async () => {
    const budget = { monthlyLimitCredits: 1000, remainingCredits: 240 };
    vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({ budget }), { status: 200 }));

    const { result } = renderHook(() => useMyMemberBudget("tenant-1"));

    await waitFor(() => expect(result.current).toEqual(budget));
    expect(authFetch).toHaveBeenCalledWith("/api/billing/me/budget");
  });

  it("设置个人预算时优先返回个人剩余额度", () => {
    expect(resolveBillingAllowance(
      { balanceCredits: 5000, billingEnabled: true, billingMode: "prepaid" },
      { monthlyLimitCredits: 1000, remainingCredits: 240 },
    )).toEqual({ credits: 240, source: "member" });
  });

  it.each([
    null,
    { monthlyLimitCredits: null, remainingCredits: null },
  ])("未设置个人预算时回退组织可用积分：%o", (budget) => {
    expect(resolveBillingAllowance(
      { balanceCredits: 5000, billingEnabled: true, billingMode: "prepaid" },
      budget,
    )).toEqual({ credits: 5000, source: "tenant" });
  });
});
