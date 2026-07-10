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
    vi.mocked(authFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ summary }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            summary: { sessionId: "session-1", creditsUsed: 35, revenueYuan: 0.35 },
          }),
          { status: 200 },
        ),
      );

    render(<BillingMiniBadge sessionId="session-1" />);

    await userEvent.click(await screen.findByTitle("组织积分余额"));

    expect(screen.getByText("试用")).toBeTruthy();
    expect(screen.getByText("已预留")).toBeTruthy();
    expect(screen.getByText("本月消耗")).toBeTruthy();
    expect(screen.getByText("当前会话")).toBeTruthy();
    expect(screen.queryByText(/每日刷新|免费积分|300/)).toBeNull();
  });

  it("保留侧边栏入口触发展开面板的能力", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ summary: { ...summary, reservedCredits: 0 } }), { status: 200 }),
    );

    requestOpenBillingBadge();
    render(<BillingMiniBadge />);

    expect(await screen.findByText("本月消耗")).toBeTruthy();
  });

  it("计费关闭时不显示入口", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ summary: { ...summary, billingEnabled: false } }),
        { status: 200 },
      ),
    );

    const { container } = render(<BillingMiniBadge />);

    await waitFor(() => {
      expect(authFetch).toHaveBeenCalledWith("/api/billing/me/summary");
    });
    expect(container.innerHTML).toBe("");
  });
});
