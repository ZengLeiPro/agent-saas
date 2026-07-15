import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dwsAuthFetch } = vi.hoisted(() => ({ dwsAuthFetch: vi.fn() }));

vi.mock("@/lib/authFetch", () => ({
  authFetch: dwsAuthFetch,
  setOnUnauthorized: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u1", username: "zenglei", tenantId: "kaiyan" } }),
}));

import { DingtalkOnlyConnectors } from "./DingtalkConnector";

function mockDws(connections: unknown[]) {
  dwsAuthFetch.mockReset().mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes("/api/dws/connections") ? { connections } : { session: null }),
  }));
}

const CONNECTED = {
  profileId: "corp-1",
  profileName: "kaiyan",
  corpName: "开沿科技",
  dingtalkUserName: "曾磊",
  status: "connected",
  authenticated: true,
  refreshTokenValid: true,
  refreshExpiresAt: null,
  lastCheckedAt: "2026-07-15T10:00:00+08:00",
  nextCheckAt: "2026-08-01T10:00:00+08:00",
  message: "登录状态由平台自动维护，无需定期重新授权",
};

describe("DingtalkOnlyConnectors（无个人 Agent 租户的钉钉连接入口）", () => {
  beforeEach(() => mockDws([]));

  it("未连接时展示钉钉卡片，点击打开抽屉可发起连接", async () => {
    render(<DingtalkOnlyConnectors />);

    expect(await screen.findByText("钉钉")).toBeTruthy();
    expect(screen.getByText("未连接")).toBeTruthy();

    fireEvent.click(screen.getByText("钉钉"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("尚未连接钉钉")).toBeTruthy();
    expect(screen.getByRole("button", { name: "连接钉钉" })).toBeTruthy();
  });

  it("已连接组织时展示连接状态与组织明细", async () => {
    mockDws([CONNECTED]);
    render(<DingtalkOnlyConnectors />);

    expect(await screen.findByText("已连接")).toBeTruthy();

    fireEvent.click(screen.getByText("钉钉"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("开沿科技")).toBeTruthy();
    });
    expect(screen.getByRole("button", { name: "连接其他组织" })).toBeTruthy();
  });

  it("连接失效时提示需重连", async () => {
    mockDws([{ ...CONNECTED, status: "disconnected", message: "钉钉授权已失效，请在能力中心的「连接器」页重新连接" }]);
    render(<DingtalkOnlyConnectors />);

    expect((await screen.findAllByText("需重连")).length).toBeGreaterThan(0);
  });
});
