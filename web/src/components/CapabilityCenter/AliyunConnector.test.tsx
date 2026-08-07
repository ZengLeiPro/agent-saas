// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchAliyunConnection: vi.fn(),
  connectAliyun: vi.fn(),
  disconnectAliyun: vi.fn(),
}));

vi.mock("@agent/shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@agent/shared")>()),
  ...api,
}));

import { AliyunConnectorDrawer, aliyunMatchesCatalog, useAliyunConnector } from "./AliyunConnector";

function TestConnector() {
  const state = useAliyunConnector(true);
  return <AliyunConnectorDrawer open onOpenChange={() => undefined} state={state} />;
}

describe("AliyunConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchAliyunConnection.mockResolvedValue({
      connection: { connectorId: "aliyun", status: "disconnected" },
    });
  });

  it("支持目录关键词和来源、启用状态筛选", () => {
    expect(aliyunMatchesCatalog("aliyun", "all", false)).toBe(true);
    expect(aliyunMatchesCatalog("ECS", "platform", false)).toBe(true);
    expect(aliyunMatchesCatalog("aliyun", "enabled", false)).toBe(false);
    expect(aliyunMatchesCatalog("阿里云", "enabled", true)).toBe(true);
    expect(aliyunMatchesCatalog("github", "all", true)).toBe(false);
  });

  it("通过 RAM 用户 AccessKey 授权并且不回显凭据", async () => {
    api.connectAliyun.mockResolvedValue({
      connection: {
        connectorId: "aliyun",
        status: "connected",
        accountId: "1234567890123456",
        identityArn: "acs:ram::1234567890123456:user/agent-saas",
        identityType: "RAMUser",
        regionId: "cn-shenzhen",
      },
    });

    render(<TestConnector />);

    fireEvent.change(await screen.findByLabelText("AccessKey ID"), { target: { value: "LTAItest" } });
    const secretInput = screen.getByLabelText("AccessKey Secret");
    expect(secretInput.getAttribute("type")).toBe("password");
    expect(secretInput.getAttribute("autocomplete")).toBe("new-password");
    expect(secretInput.getAttribute("data-1p-ignore")).toBe("true");
    fireEvent.change(secretInput, { target: { value: "source-secret" } });
    expect(screen.queryByLabelText("RAM Role ARN")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "连接阿里云" }));

    await waitFor(() => {
      expect(api.connectAliyun).toHaveBeenCalledWith({
        accessKeyId: "LTAItest",
        accessKeySecret: "source-secret",
        regionId: "cn-shenzhen",
      });
    });
    expect(await screen.findByText("1234567890123456")).toBeTruthy();
    expect(screen.queryByDisplayValue("LTAItest")).toBeNull();
    expect(screen.queryByDisplayValue("source-secret")).toBeNull();
    expect(screen.getByText("已连接，运行环境将使用该 RAM 用户权限")).toBeTruthy();
  });
});
