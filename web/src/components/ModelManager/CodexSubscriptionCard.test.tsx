import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authFetch } from "@/lib/authFetch";
import { CodexSubscriptionCard } from "./CodexSubscriptionCard";

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
    expect(screen.getByText(/generation 2/)).toBeTruthy();
    expect(screen.queryByText(/refresh_token/)).toBeNull();

    const originator = screen.getByDisplayValue("kaiyan-agent") as HTMLInputElement;
    expect(originator.disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    await waitFor(() => {
      const saveCall = vi.mocked(authFetch).mock.calls.find((call) => call[1]?.method === "PUT");
      expect(saveCall?.[0]).toBe("/api/admin/codex-subscription");
      expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
        enabled: true,
      });
    });
  });
});
