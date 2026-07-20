import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    isLoading: false,
    isAuthenticated: false,
    authEnabled: true,
    login: vi.fn(),
    loginWithSms: vi.fn(),
  }),
}));

vi.mock("@/App", () => ({ default: () => <div>应用首页</div> }));

import { AuthGate } from "@/components/AuthGate";

describe("AuthGate 登录注册切换", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("复用同一张卡片并只请求一次注册状态", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ enabled: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<AuthGate />);

    const signupButton = await screen.findByRole("button", { name: "注册试用" });
    const cardBefore = document.querySelector("[data-auth-card]");
    expect(cardBefore).not.toBeNull();

    fireEvent.click(signupButton);
    await screen.findByRole("button", { name: "注册并开始试用" });

    expect(document.querySelector("[data-auth-card]")).toBe(cardBefore);
    expect(document.querySelectorAll("[data-auth-card]").length).toBe(1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    vi.unstubAllGlobals();
  });
});
