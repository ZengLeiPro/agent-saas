import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateSelections, fetchMyMcp } = vi.hoisted(() => ({
  updateSelections: vi.fn(),
  fetchMyMcp: vi.fn(),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    isAdmin: false,
    isPlatformAdmin: false,
    user: { username: "zenglei", tenantId: "kaiyan" },
  }),
}));

vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({ tenants: [] }),
}));

vi.mock("@agent/shared", () => ({
  GLOBAL_TENANT_ID: "*",
  bindMyMcpSecret: vi.fn(),
  bindAdminMcpSecret: vi.fn(),
  deleteMcpServer: vi.fn(),
  deleteMyMcpServer: vi.fn(),
  disconnectMyMcpOAuth: vi.fn(),
  diagnoseMyMcp: vi.fn(),
  fetchMcpAdminServers: vi.fn(),
  fetchMcpTemplates: vi.fn(),
  fetchMyMcp,
  updateMyMcpSelections: updateSelections,
  startMyMcpOAuth: vi.fn(),
  upsertMcpServer: vi.fn(),
  upsertMyMcpServer: vi.fn(),
}));

import { McpManager } from "./index";

describe("McpManager 连接器目录", () => {
  beforeEach(() => {
    updateSelections.mockReset().mockResolvedValue(undefined);
    fetchMyMcp.mockReset().mockResolvedValue({
      configVersion: 1,
      servers: [
        {
          id: "stock",
          name: "通达信",
          description: "查询行情数据",
          enabledByDefault: false,
          enabled: false,
          transport: "http",
          tenantId: "*",
          secretRequirements: [{ key: "note", label: "可选备注", target: "header", name: "X-Note", scope: "user", required: false, configured: false }],
        },
        { id: "crm", name: "开沿 CRM", description: "组织客户数据", enabledByDefault: true, enabled: true, transport: "http", tenantId: "kaiyan" },
        { id: "mine", name: "我的服务", description: "个人连接器", enabledByDefault: false, enabled: false, transport: "streamable-http", tenantId: "kaiyan", personal: true, config: {} },
      ],
    });
  });

  it("展示平台、组织、个人来源并即时启用", async () => {
    render(<McpManager />);

    expect(await screen.findByText("通达信")).toBeTruthy();
    expect(screen.getByText("开沿 CRM")).toBeTruthy();
    expect(screen.getByText("我的服务")).toBeTruthy();
    expect(screen.getAllByText("平台提供").length).toBeGreaterThan(0);
    expect(screen.getAllByText("组织提供").length).toBeGreaterThan(0);
    expect(screen.getAllByText("我创建的").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "启用 通达信" }));
    await waitFor(() => {
      expect(updateSelections).toHaveBeenCalledWith(["stock", "crm"]);
    });
  });

  it("点击卡片打开详情面板", async () => {
    render(<McpManager />);
    fireEvent.click(await screen.findByText("通达信"));

    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("连接方式")).toBeTruthy();
    expect(screen.getByRole("button", { name: "启用连接器" })).toBeTruthy();
  });
});
