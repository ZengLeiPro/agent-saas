// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchGithubConnection: vi.fn(),
  connectGithub: vi.fn(),
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

  it("保存用户级凭据后直接提供 Git、gh 与 SDK 能力", async () => {
    api.fetchGithubConnection.mockResolvedValue({
      connection: { connectorId: "github", status: "disconnected" },
    });
    api.connectGithub.mockResolvedValue({
      connection: { connectorId: "github", status: "connected" },
    });

    render(<GithubConnector />);

    const tokenInput = await screen.findByLabelText("Personal Access Token");
    fireEvent.change(tokenInput, { target: { value: "github_pat_test" } });
    fireEvent.click(screen.getByRole("button", { name: "连接 GitHub" }));

    await waitFor(() => {
      expect(api.connectGithub).toHaveBeenCalledWith({ token: "github_pat_test" });
    });
    expect(await screen.findByText("已连接")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("更新凭据时把 Token 标记为新密码，避免浏览器联动填充目录搜索框", async () => {
    api.fetchGithubConnection.mockResolvedValue({
      connection: { connectorId: "github", status: "connected" },
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
});
