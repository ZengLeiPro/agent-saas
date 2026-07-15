import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform/webConfig", () => ({
  webConfig: {
    platform: "web",
    getBaseUrl: () => "https://api.example.com",
    getWsUrl: () => "",
  },
}));

import { loginWithPassword, loginWithSmsCode } from "./authApi";

const authResponse = {
  token: "test-token",
  user: {
    id: "user-1",
    username: "alice",
    role: "user" as const,
    tenantId: "tenant-1",
  },
};

describe("分域登录 API", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue(authResponse),
    }));
  });

  it("密码登录请求 API 域", async () => {
    await expect(loginWithPassword({ username: "alice", password: "secret" }))
      .resolves.toEqual(authResponse);

    expect(fetch).toHaveBeenCalledWith("https://api.example.com/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret" }),
    });
  });

  it("短信登录请求 API 域", async () => {
    await expect(loginWithSmsCode({ phone: "13800138000", code: "123456" }))
      .resolves.toEqual(authResponse);

    expect(fetch).toHaveBeenCalledWith("https://api.example.com/api/auth/sms/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "13800138000", code: "123456" }),
    });
  });
});
