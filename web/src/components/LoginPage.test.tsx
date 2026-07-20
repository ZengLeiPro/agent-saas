import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  login: vi.fn(),
  loginWithSms: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => authMocks,
}));

import { LoginPage } from "@/components/LoginPage";

describe("LoginPage 统一账号标识", () => {
  beforeEach(() => {
    authMocks.login.mockReset().mockResolvedValue(undefined);
    authMocks.loginWithSms.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("密码登录接受手机号或历史用户名", async () => {
    render(<LoginPage />);

    fireEvent.change(screen.getByLabelText("账号"), {
      target: { value: "zenglei" },
    });
    fireEvent.change(screen.getByLabelText("密码"), {
      target: { value: "secret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    await waitFor(() => {
      expect(authMocks.login).toHaveBeenCalledWith({
        username: "zenglei",
        password: "secret123",
      });
    });
  });

  it("切换短信验证码时保留同一个账号输入", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ ok: true }),
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage />);

    const accountInput = screen.getByLabelText("账号") as HTMLInputElement;
    fireEvent.change(accountInput, { target: { value: "13800138000" } });
    fireEvent.click(screen.getByRole("button", { name: "使用短信验证码登录" }));

    expect((screen.getByLabelText("账号") as HTMLInputElement).value).toBe("13800138000");
    expect(screen.queryByLabelText("密码")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "获取验证码" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/auth/sms/send-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "13800138000" }),
      });
    });

    fireEvent.change(screen.getByLabelText("验证码"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证码登录" }));

    await waitFor(() => {
      expect(authMocks.loginWithSms).toHaveBeenCalledWith({
        phone: "13800138000",
        code: "123456",
      });
    });
  });
});
