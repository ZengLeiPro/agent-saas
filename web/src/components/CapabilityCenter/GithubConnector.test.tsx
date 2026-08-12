// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchGithubConnection: vi.fn(),
  connectGithub: vi.fn(),
  disconnectGithub: vi.fn(),
  setNativeConnectorRuntimeEnabled: vi.fn(),
}));

vi.mock("@agent/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agent/shared")>()),
  ...api,
}));

import { GithubConnector } from "./GithubConnector";

describe("GithubConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("保存用户级凭据后直接提供 Git、gh 与 SDK 能力", async () => {
    api.fetchGithubConnection.mockResolvedValue({
      connection: { connectorId: "github", status: "disconnected" },
    });
    api.connectGithub.mockResolvedValue({
      connection: { connectorId: "github", status: "connected" },
    });

    render(<GithubConnector />);

    expect(await screen.findByRole("button", { name: "查看 GitHub 详情" })).toBeTruthy();
    expect(screen.queryByLabelText("Personal Access Token")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    const tokenInput = await screen.findByLabelText("Personal Access Token");
    fireEvent.change(tokenInput, { target: { value: "github_pat_test" } });
    fireEvent.click(screen.getByRole("button", { name: "连接 GitHub" }));

    await waitFor(() => {
      expect(api.connectGithub).toHaveBeenCalledWith({ token: "github_pat_test" });
    });
    await waitFor(() => {
      expect(screen.getAllByText("已连接")).toHaveLength(2);
    });
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("暂停时保留授权并把卡片操作切换为恢复", async () => {
    api.fetchGithubConnection.mockResolvedValue({
      connection: { connectorId: "github", status: "connected", runtimeEnabled: true },
    });
    api.setNativeConnectorRuntimeEnabled.mockResolvedValue({
      connectorId: "github",
      runtimeEnabled: false,
    });

    render(<GithubConnector />);
    fireEvent.click(await screen.findByRole("button", { name: "暂停" }));

    await waitFor(() => {
      expect(api.setNativeConnectorRuntimeEnabled).toHaveBeenCalledWith("github", false);
    });
    expect(await screen.findByRole("button", { name: "恢复" })).toBeTruthy();
    expect(api.disconnectGithub).not.toHaveBeenCalled();
  });

  it("更新凭据时把 Token 标记为新密码，避免浏览器联动填充目录搜索框", async () => {
    api.fetchGithubConnection.mockResolvedValue({
      connection: { connectorId: "github", status: "connected" },
    });

    render(<GithubConnector />);
    fireEvent.click(await screen.findByRole("button", { name: "查看 GitHub 详情" }));
    fireEvent.click(await screen.findByRole("button", { name: "更新凭据" }));

    const tokenInput = screen.getByLabelText("Personal Access Token");
    expect(tokenInput.getAttribute("name")).toBe("github-personal-access-token");
    expect(tokenInput.getAttribute("autocomplete")).toBe("new-password");
    expect(tokenInput.getAttribute("data-1p-ignore")).toBe("true");
    expect(tokenInput.getAttribute("data-bwignore")).toBe("true");
    expect(tokenInput.getAttribute("data-lpignore")).toBe("true");
  });
});
