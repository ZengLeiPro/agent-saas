// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchXConnection: vi.fn(),
  connectX: vi.fn(),
  disconnectX: vi.fn(),
  setNativeConnectorRuntimeEnabled: vi.fn(),
}));

vi.mock("@agent/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agent/shared")>()),
  ...api,
}));

import { XConnector } from "./XConnector";

describe("XConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("保存 auth_token 与 ct0 后提供 bird CLI 能力", async () => {
    api.fetchXConnection.mockResolvedValue({
      connection: { connectorId: "x", status: "disconnected" },
    });
    api.connectX.mockResolvedValue({
      connection: { connectorId: "x", status: "connected" },
    });

    render(<XConnector />);

    expect(await screen.findByRole("button", { name: "查看 X 详情" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    fireEvent.change(await screen.findByLabelText("auth_token"), { target: { value: "auth-cookie" } });
    fireEvent.change(screen.getByLabelText("ct0"), { target: { value: "ct0-cookie" } });
    fireEvent.click(screen.getByRole("button", { name: "连接 X" }));

    await waitFor(() => {
      expect(api.connectX).toHaveBeenCalledWith({ authToken: "auth-cookie", ct0: "ct0-cookie" });
    });
    await waitFor(() => {
      expect(screen.getAllByText("已连接")).toHaveLength(2);
    });
    expect(screen.queryByText("auth-cookie")).toBeNull();
    expect(screen.queryByText("ct0-cookie")).toBeNull();
  });

  it("暂停时保留授权并把卡片操作切换为恢复", async () => {
    api.fetchXConnection.mockResolvedValue({
      connection: { connectorId: "x", status: "connected", runtimeEnabled: true },
    });
    api.setNativeConnectorRuntimeEnabled.mockResolvedValue({
      connectorId: "x",
      runtimeEnabled: false,
    });

    render(<XConnector />);
    fireEvent.click(await screen.findByRole("button", { name: "暂停" }));

    await waitFor(() => {
      expect(api.setNativeConnectorRuntimeEnabled).toHaveBeenCalledWith("x", false);
    });
    expect(await screen.findByRole("button", { name: "恢复" })).toBeTruthy();
    expect(api.disconnectX).not.toHaveBeenCalled();
  });

  it("凭据输入使用 new-password 并禁止密码管理器联动", async () => {
    api.fetchXConnection.mockResolvedValue({
      connection: { connectorId: "x", status: "connected" },
    });

    render(<XConnector />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 X 详情" }));
    fireEvent.click(await screen.findByRole("button", { name: "更新凭据" }));

    const authToken = screen.getByLabelText("auth_token");
    const ct0 = screen.getByLabelText("ct0");
    for (const input of [authToken, ct0]) {
      expect(input.getAttribute("autocomplete")).toBe("new-password");
      expect(input.getAttribute("data-1p-ignore")).toBe("true");
      expect(input.getAttribute("data-bwignore")).toBe("true");
      expect(input.getAttribute("data-lpignore")).toBe("true");
    }
  });
});
