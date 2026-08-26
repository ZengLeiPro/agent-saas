// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  disconnectGoogleWorkspace: vi.fn(),
  fetchGoogleWorkspaceConnection: vi.fn(),
  setNativeConnectorRuntimeEnabled: vi.fn(),
  startGoogleWorkspaceOAuth: vi.fn(),
}));

vi.mock("@agent/shared", () => sharedMocks);

import { GoogleWorkspaceConnectorDrawer, useGoogleWorkspaceConnector } from "./GoogleWorkspaceConnector";

beforeEach(() => {
  sharedMocks.fetchGoogleWorkspaceConnection.mockResolvedValue({ connection: null, available: true });
  sharedMocks.startGoogleWorkspaceOAuth.mockResolvedValue({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function HookHarness() {
  const state = useGoogleWorkspaceConnector();
  return <button type="button" onClick={() => void state.connect()}>{state.connecting ? "connecting" : "ready"}</button>;
}

describe("GoogleWorkspaceConnectorDrawer", () => {
  it("已连接时允许直接扩展权限且不先断开", () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const disconnect = vi.fn().mockResolvedValue(undefined);

    render(<GoogleWorkspaceConnectorDrawer
      open
      onOpenChange={vi.fn()}
      state={{
        connection: {
          connectorId: "google-workspace",
          status: "connected",
          runtimeEnabled: true,
          cliCommand: "gws",
          envAvailable: true,
        },
        available: true,
        loading: false,
        connecting: false,
        error: null,
        connect,
        disconnect,
        setRuntimeEnabled: vi.fn().mockResolvedValue(undefined),
      }}
    />);

    fireEvent.click(screen.getByRole("button", { name: "扩展权限" }));

    expect(connect).toHaveBeenCalledTimes(1);
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("用户关闭授权弹窗后恢复可操作状态", async () => {
    const popup = {
      closed: false,
      close: vi.fn(),
      document: { write: vi.fn(), close: vi.fn() },
      location: { href: "" },
    };
    vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    render(<HookHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "ready" }));
    await screen.findByRole("button", { name: "connecting" });
    popup.closed = true;

    await waitFor(() => expect(screen.getByRole("button", { name: "ready" })).toBeTruthy());
  });
});
