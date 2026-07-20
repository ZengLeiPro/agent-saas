import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateSelections, fetchMyMcp, diagnoseMyMcp, dwsAuthFetch } = vi.hoisted(() => ({
  updateSelections: vi.fn(),
  fetchMyMcp: vi.fn(),
  diagnoseMyMcp: vi.fn(),
  dwsAuthFetch: vi.fn(),
}));

// 钉钉/飞书内置连接卡片经 @/lib/authFetch 请求各自 API。
vi.mock("@/lib/authFetch", () => ({
  authFetch: dwsAuthFetch,
  setOnUnauthorized: vi.fn(),
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
  diagnoseMyMcp,
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
    dwsAuthFetch.mockReset().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes("/api/dws/connections") ? { connections: [] } : { session: null }),
    }));
    updateSelections.mockReset().mockResolvedValue(undefined);
    diagnoseMyMcp.mockReset().mockResolvedValue({
      ok: true,
      toolCount: 2,
      tools: [],
      connections: [{
        serverName: "crm",
        status: "connected",
        toolCount: 2,
        checkedAt: "2026-07-20T14:00:00.000Z",
      }],
    });
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
    const allFilter = within(screen.getByLabelText("能力来源筛选")).getByRole("tab", { name: /全部/ });
    expect(allFilter.className).toContain("rounded-full");
    expect(allFilter.className).toContain("bg-primary");
    expect(allFilter.getAttribute("aria-selected")).toBe("true");

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

  it("钉钉与飞书内置连接以卡片形式与 MCP 连接器同 grid 展示", async () => {
    render(<McpManager />);

    expect(await screen.findByText("钉钉")).toBeTruthy();
    expect(screen.getByText("飞书")).toBeTruthy();
    expect(screen.getAllByText("未连接")).toHaveLength(2);
    expect(dwsAuthFetch).toHaveBeenCalledWith("/api/dws/connections");
    expect(dwsAuthFetch).toHaveBeenCalledWith("/api/feishu/connections");

    fireEvent.click(screen.getByText("钉钉"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("尚未连接钉钉")).toBeTruthy();
    expect(screen.getByRole("button", { name: "连接钉钉" })).toBeTruthy();
  });

  it("进入目录后自动做真实检测，只有握手成功才显示可用", async () => {
    render(<McpManager />);

    expect(await screen.findByText("可用 · 2 个工具")).toBeTruthy();
    expect(diagnoseMyMcp).toHaveBeenCalledWith(false);
  });

  it("真实连接失败时显示异常和脱敏错误，并允许强制重新检测", async () => {
    diagnoseMyMcp.mockResolvedValue({
      ok: false,
      error: "Authorization header is badly formatted",
      toolCount: 0,
      tools: [],
      connections: [{
        serverName: "crm",
        status: "error",
        toolCount: 0,
        checkedAt: "2026-07-20T14:00:00.000Z",
        lastError: "Authorization header is badly formatted",
      }],
    });
    render(<McpManager />);

    expect(await screen.findByText("连接异常")).toBeTruthy();
    fireEvent.click(screen.getByText("开沿 CRM"));
    expect(await screen.findByText("Authorization header is badly formatted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));
    await waitFor(() => expect(diagnoseMyMcp).toHaveBeenLastCalledWith(true));
  });
});
