import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { CodexSubscriptionCard, formatCooldownRemaining } from "./CodexSubscriptionCard";

vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn() }));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const connectedState = {
  config: {
    enabled: true,
    websocketEnabled: true,
    quotaCooldownMinutes: 60,
    endpoint: "https://chatgpt.com/backend-api/codex/responses",
    originator: "kaiyan-agent",
  },
  credential: {
    configured: true,
    connected: true,
    accountBindingHash: "binding-hash",
    accountIdHint: "123456",
    email: "admin@example.com",
    expiresAt: "2026-07-30T00:00:00.000Z",
    generation: 1,
  },
  runtime: {
    requestWindow: {
      limit: 50,
      sampleCount: 3,
      eligibleRequestCount: 2,
      cacheHitRequestCount: 2,
      eligibleInputTokens: 3_000,
      cachedInputTokens: 2_400,
      cacheHitRequestRate: 1,
      cachedInputTokenRate: 0.8,
    },
    wireWindow: {
      limit: 50,
      sampleCount: 3,
      websocketRequestCount: 3,
      relayRequestCount: 2,
      fallbackFullRequestCount: 0,
      httpFallbackRequestCount: 0,
      logicalRequestBodyBytes: 12_000,
      wireRequestBodyBytes: 4_000,
      savedRequestBodyBytes: 8_000,
      savedRequestBodyRate: 2 / 3,
    },
    lastRequestAt: "2026-07-29T15:30:00.000Z",
    lastSuccessAt: "2026-07-29T15:30:00.000Z",
    lastModel: "gpt-5.4",
    oauth: {
      lastRefreshAt: "2026-07-29T15:00:00.000Z",
      lastRefreshGeneration: 2,
    },
  },
};

describe("CodexSubscriptionCard", () => {
  afterEach(() => vi.useRealTimers());

  beforeEach(() => {
    vi.mocked(authFetch).mockReset();
    vi.mocked(authFetch).mockImplementation(async (_path, init) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return jsonResponse({
          ...connectedState,
          config: { ...connectedState.config, ...body },
        });
      }
      return jsonResponse(connectedState);
    });
  });

  it("显示脱敏账号状态并保存 transport 设置", async () => {
    const user = userEvent.setup();
    render(<CodexSubscriptionCard readOnly={false} />);

    expect(await screen.findByText("已连接")).toBeTruthy();
    expect(screen.getByText(/admin@example.com/)).toBeTruthy();
    expect(screen.getByText(/binding-hash/)).toBeTruthy();
    expect(screen.getByText(/2\/2（100.0%）/)).toBeTruthy();
    expect(screen.getByText(/2,400\/3,000（80.0%）/)).toBeTruthy();
    expect(screen.getByText(/代次 2/)).toBeTruthy();
    expect(screen.queryByText(/refresh_token/)).toBeNull();

    const originator = screen.getByDisplayValue("kaiyan-agent") as HTMLInputElement;
    expect(originator.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      const saveCall = vi.mocked(authFetch).mock.calls.find((call) => call[1]?.method === "PUT");
      expect(saveCall?.[0]).toBe("/api/admin/codex-subscription");
      expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
        enabled: true,
        websocketEnabled: true,
        quotaCooldownMinutes: 60,
      });
    });
  });

  it("按当前时间显示确定性的冷却剩余时间", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-02T23:50:30.000Z"));

    expect(formatCooldownRemaining("2026-09-03T00:00:00.000Z")).toBe("9 分 30 秒");
  });

  it("展示额度冷却和授权异常账号状态", async () => {
    vi.mocked(authFetch).mockResolvedValueOnce(jsonResponse({
      ...connectedState,
      credentials: [
        {
          ...connectedState.credential,
          id: "credential-cooling",
          availability: "quota_cooldown",
          cooldownUntil: "2026-09-03T00:00:00.000Z",
          lastFailureCode: "insufficient_quota",
        },
        {
          ...connectedState.credential,
          id: "credential-auth",
          email: "backup@example.com",
          availability: "auth_unavailable",
          lastFailureCode: "invalid_grant",
        },
      ],
    }));

    render(<CodexSubscriptionCard readOnly={false} />);

    expect(await screen.findByText("额度冷却")).toBeTruthy();
    expect(screen.getByText("需重授权")).toBeTruthy();
    expect(screen.getByText(/剩余/)).toBeTruthy();
    expect(screen.getByText(/insufficient_quota/)).toBeTruthy();
    expect(screen.getByText(/invalid_grant/)).toBeTruthy();
    expect(screen.getByDisplayValue("60")).toBeTruthy();
  });
});
