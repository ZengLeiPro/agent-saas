import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BillingMiniBadge } from "./BillingMiniBadge";
import { authFetch } from "@/lib/authFetch";
import { requestOpenBillingBadge } from "@/lib/billingBadgeBus";

vi.mock("@/lib/authFetch", () => ({
  authFetch: vi.fn(),
}));

const summary = {
  balanceCredits: 1280,
  reservedCredits: 80,
  lowBalance: false,
  billingEnabled: true,
  billingMode: "trial",
  currentMonthCreditsUsed: 420,
  currentMonthRevenueYuan: 4.2,
};

describe("BillingMiniBadge", () => {
  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
  });

  it("只展示服务端返回的真实计费字段", async () => {
    vi.mocked(authFetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/billing/me/summary") {
        return new Response(JSON.stringify({ summary }), { status: 200 });
      }
      if (url.includes("/api/billing/sessions/")) {
        return new Response(
          JSON.stringify({
            summary: {
              sessionId: "session-1",
              creditsUsed: 2737.58,
              revenueYuan: 547.502908,
              childSessionCount: 7,
            },
          }),
          { status: 200 },
        );
      }
      if (url === "/api/billing/me/budget") {
        return new Response(JSON.stringify({
          budget: {
            monthlyLimitCredits: 2000,
            monthUsedCredits: 1500,
            usageRatioBps: 7500,
            status: "attention",
          },
        }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    render(<BillingMiniBadge sessionId="session-1" />);

    await userEvent.click(await screen.findByTitle("组织积分余额"));

    expect(screen.getByText("试用")).toBeTruthy();
    expect(screen.getByText("已预留")).toBeTruthy();
    expect(screen.getByText("组织本月消耗")).toBeTruthy();
    expect(screen.getByText("我的本月用量")).toBeTruthy();
    expect(screen.getByText("1,500")).toBeTruthy();
    expect(screen.getByText("75% · 需要关注")).toBeTruthy();
    expect(screen.getByText("当前会话（含 7 个子 Agent）")).toBeTruthy();
    expect(screen.getByText("2,737.58")).toBeTruthy();
    expect(screen.queryByText(/员工预算仅用于提醒/)).toBeNull();
    expect(screen.queryByText(/每日刷新|免费积分|300/)).toBeNull();
  });

  it("保留侧边栏入口触发展开面板的能力", async () => {
    vi.mocked(authFetch).mockImplementation(async (input) => (
      String(input) === "/api/billing/me/summary"
        ? new Response(JSON.stringify({ summary: { ...summary, reservedCredits: 0 } }), { status: 200 })
        : new Response(null, { status: 404 })
    ));

    requestOpenBillingBadge();
    render(<BillingMiniBadge />);

    expect(await screen.findByText("组织本月消耗")).toBeTruthy();
    expect(screen.getByText("个人预算数据暂不可用")).toBeTruthy();
  });

  it("计费关闭时不显示入口", async () => {
    vi.mocked(authFetch).mockImplementation(async (input) => (
      String(input) === "/api/billing/me/summary"
        ? new Response(
          JSON.stringify({ summary: { ...summary, billingEnabled: false } }),
          { status: 200 },
        )
        : new Response(null, { status: 404 })
    ));

    const { container } = render(<BillingMiniBadge />);

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith("/api/billing/me/summary");
    });
    expect(container.innerHTML).toBe("");
  });
});
