// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GoogleWorkspaceConnectorDrawer } from "./GoogleWorkspaceConnector";

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
});
