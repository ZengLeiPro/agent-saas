// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchGithubConnection: vi.fn(),
  connectGithub: vi.fn(),
  updateGithubCapabilities: vi.fn(),
  disconnectGithub: vi.fn(),
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

  it("用一个原生连接保存凭据，并把 MCP 作为可选能力", async () => {
    api.fetchGithubConnection.mockResolvedValue({
      connection: { connectorId: "github", status: "disconnected", mcpEnabled: false },
    });
    api.connectGithub.mockResolvedValue({
      connection: { connectorId: "github", status: "connected", mcpEnabled: true },
    });

    render(<GithubConnector />);

    const tokenInput = await screen.findByLabelText("Personal Access Token");
    fireEvent.change(tokenInput, { target: { value: "github_pat_test" } });
    fireEvent.click(screen.getByRole("button", { name: "连接 GitHub" }));

    await waitFor(() => {
      expect(api.connectGithub).toHaveBeenCalledWith({ token: "github_pat_test", mcpEnabled: true });
    });
    expect(await screen.findByText("已连接")).toBeTruthy();
  });

  it("更新凭据时把 Token 标记为新密码，避免浏览器联动填充目录搜索框", async () => {
    api.fetchGithubConnection.mockResolvedValue({
      connection: { connectorId: "github", status: "connected", mcpEnabled: true },
    });

    render(<GithubConnector />);
    fireEvent.click(await screen.findByRole("button", { name: "更新凭据" }));

    const tokenInput = screen.getByLabelText("Personal Access Token");
    expect(tokenInput.getAttribute("name")).toBe("github-personal-access-token");
    expect(tokenInput.getAttribute("autocomplete")).toBe("new-password");
    expect(tokenInput.getAttribute("data-1p-ignore")).toBe("true");
    expect(tokenInput.getAttribute("data-bwignore")).toBe("true");
    expect(tokenInput.getAttribute("data-lpignore")).toBe("true");
  });

  it("连接状态与 MCP 工具开关相互独立", async () => {
    api.fetchGithubConnection.mockResolvedValue({
      connection: { connectorId: "github", status: "connected", mcpEnabled: true },
    });
    api.updateGithubCapabilities.mockResolvedValue({
      connection: { connectorId: "github", status: "connected", mcpEnabled: false },
    });

    render(<GithubConnector />);

    const toggle = await screen.findByRole("switch");
    fireEvent.click(toggle);

    await waitFor(() => expect(api.updateGithubCapabilities).toHaveBeenCalledWith(false));
    expect(screen.getByText("已连接")).toBeTruthy();
  });
});
