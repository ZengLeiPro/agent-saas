import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));

vi.mock("@/lib/authFetch", () => ({ authFetch, setOnUnauthorized: vi.fn() }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { id: "u1", username: "alice", tenantId: "kaiyan" } }),
}));

import {
  FeishuConnectorCard,
  FeishuConnectorDrawer,
  useFeishuConnections,
} from "./FeishuConnector";
import { useState } from "react";

function Harness() {
  const state = useFeishuConnections();
  const [open, setOpen] = useState(false);
  return (
    <>
      <FeishuConnectorCard state={state} onOpenDetail={() => setOpen(true)} />
      <FeishuConnectorDrawer open={open} onOpenChange={setOpen} state={state} />
    </>
  );
}

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("FeishuConnector", () => {
  beforeEach(() => {
    authFetch.mockReset().mockImplementation(async (url: string) => (
      url.endsWith("/connections") ? response({ connections: [] }) : response({ session: null })
    ));
  });

  it("未连接时展示同级卡片与授权入口", async () => {
    render(<Harness />);
    expect(await screen.findByText("飞书")).toBeTruthy();
    expect(screen.getByText("未连接")).toBeTruthy();
    fireEvent.click(screen.getByText("飞书"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("尚未连接飞书")).toBeTruthy();
    expect(screen.getByRole("button", { name: "连接飞书" })).toBeTruthy();
  });

  it("服务端未配置企业应用时禁用按钮并明确显示待配置", async () => {
    authFetch.mockImplementation(async (url: string) => (
      url.endsWith("/connections")
        ? response({ connections: [] })
        : response({ error: "飞书连接服务尚未配置" }, 503)
    ));
    render(<Harness />);
    expect(await screen.findByText("待配置")).toBeTruthy();
    fireEvent.click(screen.getByText("飞书"));
    const button = await screen.findByRole("button", { name: "服务尚未配置" });
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("点击连接先打开等待页，再无缝跳到飞书官方授权 URL", async () => {
    const popup = {
      closed: false,
      opener: {} as unknown,
      location: { href: "" },
      document: {
        open: vi.fn(),
        write: vi.fn(),
        close: vi.fn(),
        title: "",
        body: { textContent: "" },
      },
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    authFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/connections")) return response({ connections: [] });
      if (init?.method === "POST") {
        return response({
          session: {
            sessionId: "auth-1",
            status: "awaiting_user",
            authorizationUrl: "https://accounts.feishu.cn/device?user_code=ABC",
            expiresAt: "2099-07-21T04:00:00.000Z",
            message: "请在飞书官方页面确认授权",
          },
        }, 202);
      }
      return response({ session: null });
    });
    render(<Harness />);
    fireEvent.click(await screen.findByText("飞书"));
    fireEvent.click(await screen.findByRole("button", { name: "连接飞书" }));

    await waitFor(() => {
      expect(popup.document.write).toHaveBeenCalled();
      expect(popup.location.href).toBe("https://accounts.feishu.cn/device?user_code=ABC");
    });
    expect(authFetch).toHaveBeenCalledWith("/api/feishu/auth/session", { method: "POST" });
  });
});
