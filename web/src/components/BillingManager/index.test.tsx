import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { TenantBillingPanel } from "./index";

vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn() }));

const summary = {
  tenantId: "wain",
  balanceCredits: 5000,
  reservedCredits: 0,
  lowBalance: false,
  billingEnabled: true,
  billingMode: "prepaid",
  pricingVersion: "v1",
  policyVersion: "v1",
  creditValueYuan: 0.01,
  currentMonthCreditsUsed: 1200,
  currentMonthRevenueYuan: 12,
};

const policy = {
  tenantId: "wain",
  policyVersion: "v1",
  billingEnabled: true,
  pricingVersion: "v1",
  billingMode: "prepaid",
  defaultTargetMarginBps: 5000,
  organizationMultiplierBps: 10000,
  allowNegativeBalance: false,
  negativeLimitCreditsMicro: 0,
  lowBalanceThresholdCreditsMicro: 100_000_000,
  hardCapMode: "stop_before_run",
  showBalance: true,
  showUsageCredits: true,
  showCost: false,
  showGrossMargin: false,
  updatedBy: "platform_admin",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const budgets = {
  period: {
    start: "2026-07-31T16:00:00.000Z",
    end: "2026-08-31T16:00:00.000Z",
    timezone: "Asia/Shanghai",
  },
  summary: {
    tenantBalanceCredits: 5000,
    monthUsedCredits: 1200,
    budgetedUsers: 1,
    nearLimitUsers: 0,
    overLimitUsers: 0,
    unattributedCredits: 20,
  },
  items: [{
    userId: "user-1",
    username: "alice",
    realName: "爱丽丝",
    role: "user",
    disabled: false,
    canManage: true,
    monthlyLimitCredits: 2000,
    monthUsedCredits: 1200,
    usageRatioBps: 6000,
    status: "normal",
    active: true,
    version: 2,
    lastUsedAt: "2026-08-01T01:00:00.000Z",
  }],
};

function mockBillingApi() {
  vi.mocked(authFetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("/api/admin/billing/accounts")) {
      return new Response(JSON.stringify({ summary }), { status: 200 });
    }
    if (url.includes("/api/admin/billing/tenants/") && url.endsWith("/policy")) {
      return new Response(JSON.stringify({ policy }), { status: 200 });
    }
    if (url.includes("/api/admin/billing/ledger")) {
      return new Response(JSON.stringify({ entries: [] }), { status: 200 });
    }
    if (url.includes("/api/admin/billing/member-budgets/") && init?.method === "PUT") {
      return new Response(JSON.stringify({
        budget: { ...budgets.items[0], monthlyLimitCredits: 2500, version: 3 },
        audit: { id: "audit-1" },
        replayed: false,
      }), { status: 200 });
    }
    if (url.includes("/api/admin/billing/member-budgets")) {
      return new Response(JSON.stringify(budgets), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
}

describe("TenantBillingPanel 员工预算", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    mockBillingApi();
  });

  it("展示共享池预算语义和成员预算汇总", async () => {
    render(<TenantBillingPanel tenantId="wain" tenantName="外星科技" />);

    expect(await screen.findByText("员工预算")).toBeTruthy();
    expect(screen.getByText(/员工预算只做用量提醒/)).toBeTruthy();
    expect(screen.getByText("爱丽丝")).toBeTruthy();
    expect(screen.getByText("未归属用量")).toBeTruthy();
    expect(screen.getByText("20")).toBeTruthy();
  });

  it("设置预算时发送版本号、幂等键和备注", async () => {
    render(<TenantBillingPanel tenantId="wain" tenantName="外星科技" />);
    await userEvent.click(await screen.findByRole("button", { name: "调整" }));
    const amount = await screen.findByPlaceholderText("留空表示未设置");
    await userEvent.clear(amount);
    await userEvent.type(amount, "2500");
    await userEvent.type(screen.getByPlaceholderText("说明设置或调整原因"), "8 月团队预算");
    await userEvent.click(screen.getByRole("button", { name: "保存预算" }));

    await waitFor(() => {
      const putCall = vi.mocked(authFetch).mock.calls.find(([, init]) => init?.method === "PUT");
      expect(putCall).toBeTruthy();
      expect(putCall?.[0]).toBe("/api/admin/billing/member-budgets/user-1?tenantId=wain");
      const body = JSON.parse(String(putCall?.[1]?.body));
      expect(body).toMatchObject({
        monthlyLimitCredits: 2500,
        expectedVersion: 2,
        note: "8 月团队预算",
      });
      expect(body.idempotencyKey).toEqual(expect.any(String));
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
