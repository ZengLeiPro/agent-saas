import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserManager } from "@/components/UserManager";
import { governanceRoute } from "@/lib/governanceNavigation";
import { PlatformAdminShell, TenantAdminShell } from "./AdminShells";

const adminShellMocks = vi.hoisted(() => ({
  auth: { user: { tenantId: "acme" }, isPlatformAdmin: false },
  tenants: [{ id: "acme", name: "Acme" }],
  tenantsLoading: false,
  contextSnapshot: vi.fn(),
}));

vi.mock("@agent/shared/lib/governanceApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agent/shared/lib/governanceApi")>();
  return {
    ...actual,
    contextCenterApi: {
      getSnapshot: adminShellMocks.contextSnapshot,
      listEvidence: vi.fn().mockResolvedValue([]),
    },
    governanceAccessApi: {
      ...actual.governanceAccessApi,
      listPlatformAdmins: vi.fn().mockResolvedValue({ platformAdmins: [] }),
      listMemberships: vi.fn().mockResolvedValue({ memberships: [
        { userId: "member-1", persona: "member", isOwner: false, status: "active", version: 1, allowedActions: [] },
      ] }),
      listMemoryKnowledge: vi.fn().mockResolvedValue({
        tenantId: "acme", authority: "governance_assignment_sets", accessMode: "inspect",
        suites: [], knowledge: [], memory: [], effective: { organizationKnowledge: false, organizationMemory: false },
      }),
    },
    governanceResourcesApi: {
      ...actual.governanceResourcesApi,
      listAgentTemplates: vi.fn().mockResolvedValue({ agents: [
        { agentId: "template-1", tenantId: "pantheon", status: "draft", revision: 1 },
      ] }),
      listEnvironmentTemplates: vi.fn().mockResolvedValue({ templates: [] }),
    },
  };
});
vi.mock("@/lib/authFetch", () => ({ authFetch: vi.fn(() => new Promise(() => undefined)) }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    ...adminShellMocks.auth,
    canPlatform: () => true,
  }),
}));
vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({ tenants: adminShellMocks.tenants, loading: adminShellMocks.tenantsLoading }),
}));
vi.mock("@/components/PlatformAdmin/pages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/PlatformAdmin/pages")>();
  return { ...actual, SandboxesPage: ({ sandboxName }: { sandboxName?: string | null }) => <div>环境实例 {sandboxName ?? "列表"}</div> };
});
vi.mock("@/components/RunTraceExplorer", () => ({
  RunTraceExplorer: ({ runId, onRunIdChange }: { runId?: string | null; onRunIdChange?: (runId: string | null) => void }) => (
    <button type="button" onClick={() => onRunIdChange?.(runId ? null : "run-1")}>
      {runId ? "返回运行列表" : "打开运行详情"}
    </button>
  ),
}));
vi.mock("@/components/EgressConfigManager", () => ({ default: () => <div>网络与安全管理器</div> }));
vi.mock("@/components/SystemPromptsManager", () => ({ default: () => <div>系统提示语管理器</div> }));
vi.mock("@/components/PlatformAdmin/SystemSettingsPanel", () => ({ SystemSettingsPanel: () => <div>系统配置管理器</div> }));
vi.mock("@/components/WorkflowDisplaySettingsPage", () => ({
  default: ({ tenantId }: { tenantId: string }) => <div>工作流设置 {tenantId}</div>,
}));
vi.mock("@/components/BillingManager", () => ({
  PlatformBillingManager: () => <div>平台计费管理器</div>,
  TenantBillingPanel: ({ tenantId, tenantName }: { tenantId: string; tenantName?: string }) => (
    <div>组织预算面板 {tenantId} {tenantName}</div>
  ),
}));

const commonTenantProps = {
  renderSkills: () => <div>复用 SkillManager</div>,
  renderOrgAgents: () => <div>复用 OrgAgentManager</div>,
  renderMcp: () => <div>复用 Connector Catalog</div>,
  renderUsage: () => <div>复用 TenantAnalytics</div>,
  renderFiles: () => <div>复用 FileBrowser</div>,
  renderCompanyInfo: () => <div>复用 CompanyInfo</div>,
  settingsOpen: false,
  settingsSection: "users" as const,
  onSettingsSectionChange: () => undefined,
  onSettingsClose: () => undefined,
  governanceContentOnly: true,
};

describe("AdminShells V2 内容适配", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    adminShellMocks.auth = { user: { tenantId: "acme" }, isPlatformAdmin: false };
    adminShellMocks.tenants = [{ id: "acme", name: "Acme" }];
    adminShellMocks.tenantsLoading = false;
    adminShellMocks.contextSnapshot.mockReset().mockResolvedValue({
      generatedAt: "2026-08-22T15:40:00.000Z", sources: [], consumers: [],
    });
  });

  it("新版用量页面可切换到组织预算面板", async () => {
    window.history.replaceState({}, "", "/tenant-admin/governance/usage?org=acme");
    render(
      <TenantAdminShell
        {...commonTenantProps}
        renderUsers={() => <div>复用 UserManager</div>}
        governanceRoute={governanceRoute("organization.governance.usage", { orgId: "acme" })}
      />,
    );

    expect(screen.getByText("复用 TenantAnalytics")).toBeTruthy();
    expect(screen.queryByText(/组织预算面板/)).toBeNull();
    await userEvent.click(screen.getByRole("tab", { name: "预算与计费" }));
    expect(await screen.findByText("组织预算面板 acme Acme")).toBeTruthy();
    expect(window.location.search).toContain("usageSection=billing");
  });

  it("平台管理员未选择 org 时不默认使用首个业务组织", () => {
    adminShellMocks.auth = { user: { tenantId: "pantheon" }, isPlatformAdmin: true };
    adminShellMocks.tenants = [
      { id: "pantheon", name: "万神殿" },
      { id: "kaiyan-demo", name: "开沿演示" },
    ];
    window.history.replaceState({}, "", "/tenant-admin/governance/usage");
    render(
      <TenantAdminShell
        {...commonTenantProps}
        renderUsers={() => <div />}
        governanceRoute={governanceRoute("organization.governance.usage")}
      />,
    );

    expect(screen.getByRole("heading", { name: "请先选择目标组织" })).toBeTruthy();
    expect(screen.queryByText(/组织预算面板 kaiyan-demo/)).toBeNull();
  });

  it("平台管理员必须显式选择组织后才显示旧设置页的添加成员入口", async () => {
    adminShellMocks.auth = { user: { tenantId: "pantheon" }, isPlatformAdmin: true };
    adminShellMocks.tenants = [
      { id: "pantheon", name: "万神殿" },
      { id: "acme", name: "Acme" },
      { id: "beta", name: "Beta" },
    ];

    const renderUsers = (tenantId?: string, tenantName?: string) => (
      <UserManager tenantIdScope={tenantId} tenantName={tenantName} />
    );
    const { unmount } = render(
      <TenantAdminShell
        {...commonTenantProps}
        settingsOpen
        settingsContentOnly
        renderUsers={renderUsers}
        governanceRoute={governanceRoute("organization.overview.overview")}
      />,
    );

    expect(screen.getByRole("combobox", { name: "切换组织管理目标" }).textContent).toContain("请选择目标组织");
    expect(screen.queryByRole("button", { name: "添加成员" })).toBeNull();
    unmount();

    window.history.replaceState({}, "", "/tenant-admin/settings/users?org=acme");
    render(
      <TenantAdminShell
        {...commonTenantProps}
        settingsOpen
        settingsContentOnly
        renderUsers={renderUsers}
        governanceRoute={governanceRoute("organization.overview.overview", { orgId: "acme" })}
      />,
    );

    expect(screen.getByRole("button", { name: "添加成员" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "添加成员" }));
    expect(window.location.pathname).toBe("/tenant-admin/members/list");
    expect(window.location.search).toBe("?org=acme");
  });

  it("统一组织设置的工作流入口挂载目标组织的工作流配置页", async () => {
    adminShellMocks.auth = { user: { tenantId: "pantheon" }, isPlatformAdmin: true };
    adminShellMocks.tenants = [
      { id: "pantheon", name: "万神殿" },
      { id: "kaiyan-demo", name: "开沿演示组织" },
    ];
    window.history.replaceState({}, "", "/tenant-admin/settings/workflows?org=kaiyan-demo");

    render(
      <TenantAdminShell
        {...commonTenantProps}
        settingsOpen
        settingsContentOnly
        settingsSection="workflows"
        renderUsers={() => <div />}
      />,
    );

    expect(await screen.findByText("工作流设置 kaiyan-demo")).toBeTruthy();
  });

  it("统一设置隐藏组织分组后继续回传持久 Shell 的实际组织", async () => {
    adminShellMocks.auth = { user: { tenantId: "pantheon" }, isPlatformAdmin: true };
    adminShellMocks.tenants = [
      { id: "pantheon", name: "万神殿" },
      { id: "acme", name: "Acme" },
    ];
    window.history.replaceState({}, "", "/tenant-admin/settings/users");
    const onTargetChange = vi.fn();
    const { rerender, unmount } = render(
      <TenantAdminShell
        {...commonTenantProps}
        settingsOpen
        settingsContentOnly
        renderUsers={() => <div />}
        onSettingsTargetTenantIdChange={onTargetChange}
      />,
    );
    expect(onTargetChange).toHaveBeenLastCalledWith(null);
    await userEvent.click(screen.getByRole("combobox", { name: "切换组织管理目标" }));
    await userEvent.click(screen.getByRole("option", { name: "Acme" }));
    expect(onTargetChange).toHaveBeenLastCalledWith("acme");
    expect(window.location.search).toBe("?org=acme");

    await userEvent.click(screen.getByRole("combobox", { name: "切换组织管理目标" }));
    await userEvent.click(screen.getByRole("option", { name: "请选择目标组织" }));
    expect(onTargetChange).toHaveBeenLastCalledWith(null);
    expect(window.location.search).toBe("");
    await userEvent.click(screen.getByRole("combobox", { name: "切换组织管理目标" }));
    await userEvent.click(screen.getByRole("option", { name: "Acme" }));
    expect(onTargetChange).toHaveBeenLastCalledWith("acme");

    act(() => window.history.back());
    await waitFor(() => expect(onTargetChange).toHaveBeenLastCalledWith(null));
    act(() => window.history.forward());
    await waitFor(() => expect(onTargetChange).toHaveBeenLastCalledWith("acme"));

    window.history.replaceState({}, "", "/platform-admin/settings/models");
    rerender(
      <TenantAdminShell
        {...commonTenantProps}
        settingsOpen={false}
        settingsContentOnly
        renderUsers={() => <div />}
        onSettingsTargetTenantIdChange={onTargetChange}
      />,
    );
    act(() => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(onTargetChange).toHaveBeenLastCalledWith("acme");

    window.history.replaceState({}, "", "/tenant-admin/settings/skills");
    rerender(
      <TenantAdminShell
        {...commonTenantProps}
        settingsOpen
        settingsContentOnly
        settingsSection="skills"
        renderUsers={() => <div />}
        onSettingsTargetTenantIdChange={onTargetChange}
      />,
    );
    expect(onTargetChange).toHaveBeenLastCalledWith("acme");

    unmount();
    expect(onTargetChange).toHaveBeenLastCalledWith(undefined);
  });

  it("平台组织目录加载完成前不把 URL 目标误报为明确未选择", () => {
    adminShellMocks.auth = { user: { tenantId: "pantheon" }, isPlatformAdmin: true };
    adminShellMocks.tenants = [];
    adminShellMocks.tenantsLoading = true;
    window.history.replaceState({}, "", "/tenant-admin/settings/users?org=acme");
    const onTargetChange = vi.fn();
    const { rerender } = render(
      <TenantAdminShell
        {...commonTenantProps}
        settingsOpen
        settingsContentOnly
        renderUsers={() => <div />}
        onSettingsTargetTenantIdChange={onTargetChange}
      />,
    );
    expect(onTargetChange).toHaveBeenLastCalledWith(undefined);

    adminShellMocks.tenants = [{ id: "acme", name: "Acme" }];
    adminShellMocks.tenantsLoading = false;
    rerender(
      <TenantAdminShell
        {...commonTenantProps}
        settingsOpen
        settingsContentOnly
        renderUsers={() => <div />}
        onSettingsTargetTenantIdChange={onTargetChange}
      />,
    );
    expect(onTargetChange).toHaveBeenLastCalledWith("acme");
  });

  it("组织成员叶子读取治理 Membership，不回退 legacy UserManager 身份", async () => {
    render(
      <TenantAdminShell
        {...commonTenantProps}
        renderUsers={() => <div>复用 UserManager</div>}
        governanceRoute={governanceRoute("organization.members.list", { orgId: "acme" })}
      />,
    );
    expect(await screen.findByText("member-1")).toBeTruthy();
    expect(screen.queryByText("复用 UserManager")).toBeNull();
  });

  it("账号与登录叶子复用完整 UserManager 账号操作能力", () => {
    render(
      <TenantAdminShell
        {...commonTenantProps}
        renderUsers={() => <div>复用 UserManager</div>}
        governanceRoute={governanceRoute("organization.members.accounts", { orgId: "acme" })}
      />,
    );

    expect(screen.getByText("复用 UserManager")).toBeTruthy();
  });

  it("MCP 服务叶子复用完整 Connector Catalog 管理能力", () => {
    render(
      <TenantAdminShell
        {...commonTenantProps}
        renderUsers={() => <div />}
        renderMcp={() => <div>连接器管理器</div>}
        governanceRoute={governanceRoute("organization.agents.mcp-catalog", { orgId: "acme" })}
      />,
    );

    expect(screen.getByText("连接器管理器")).toBeTruthy();
  });

  it("组织记忆与知识叶子在原区域内接入 Context Center，不增加顶级路由", async () => {
    render(
      <TenantAdminShell
        {...commonTenantProps}
        renderUsers={() => <div />}
        governanceRoute={governanceRoute("organization.agents.memory-knowledge", { orgId: "acme" })}
      />,
    );

    expect(await screen.findByRole("tab", { name: "资源治理" })).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Context Center" }));
    expect(await screen.findByRole("heading", { name: "Context Center" })).toBeTruthy();
    expect(adminShellMocks.contextSnapshot).toHaveBeenCalledTimes(1);
  });

  it("运行列表下钻与内部返回保留筛选且返回不新增历史层", async () => {
    const search = "?tenantId=acme&status=failed&hours=168";
    window.history.replaceState(
      { analysisWorkspace: { source: "/chat/session-1", depth: 1 } },
      "",
      `/platform-console/runtime/runs${search}`,
    );
    const pushState = vi.spyOn(window.history, "pushState");
    const replaceState = vi.spyOn(window.history, "replaceState");
    const props = {
      renderTenants: () => <div />,
      renderModels: () => <div />,
      renderRemoteHands: () => <div />,
      renderToolControls: () => <div />,
      renderMemoryPolling: () => <div />,
      renderMcp: () => <div />,
      renderSkills: () => <div />,
      renderEfficiency: () => <div />,
      activeSection: "runs" as const,
      entityId: null,
      onSectionChange: () => undefined,
      settingsOpen: false,
      settingsSection: "tenants" as const,
      onSettingsSectionChange: () => undefined,
      onSettingsClose: () => undefined,
      governanceContentOnly: true,
    };
    const { rerender } = render(
      <PlatformAdminShell
        {...props}
        governanceRoute={governanceRoute("platform.runtime.runs", { search })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "打开运行详情" }));
    expect(window.location.pathname).toBe("/platform-console/runtime/runs/run-1");
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
      hours: "168",
      status: "failed",
      tenantId: "acme",
    });
    expect(window.history.state.analysisWorkspace).toEqual({ source: "/chat/session-1", depth: 2 });

    rerender(
      <PlatformAdminShell
        {...props}
        entityId="run-1"
        governanceRoute={governanceRoute("platform.runtime.runs", { entityId: "run-1", search })}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "返回运行列表" }));

    expect(window.location.pathname).toBe("/platform-console/runtime/runs");
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({
      hours: "168",
      status: "failed",
      tenantId: "acme",
    });
    expect(window.history.state.analysisWorkspace).toEqual({ source: "/chat/session-1", depth: 2 });
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["platform.resource-center.models", "模型管理器"],
    ["platform.runtime.execution-providers", "执行提供方管理器"],
    ["platform.governance.memory-policy", "记忆策略管理器"],
  ])("平台控制台叶子 %s 挂载已有真实管理器", (routeId, expected) => {
    render(
      <PlatformAdminShell
        renderTenants={() => <div>组织管理器</div>}
        renderModels={() => <div>模型管理器</div>}
        renderRemoteHands={() => <div>执行提供方管理器</div>}
        renderToolControls={() => <div>工具管理器</div>}
        renderMemoryPolling={() => <div>记忆策略管理器</div>}
        renderMcp={() => <div>连接器管理器</div>}
        renderSkills={() => <div>技能管理器</div>}
        renderEfficiency={() => <div>效率分析</div>}
        activeSection="overview"
        entityId={null}
        onSectionChange={() => undefined}
        settingsOpen={false}
        settingsSection="tenants"
        onSettingsSectionChange={() => undefined}
        onSettingsClose={() => undefined}
        governanceRoute={governanceRoute(routeId)}
        governanceContentOnly
      />,
    );
    expect(screen.getByText(expected)).toBeTruthy();
    expect(screen.queryByText("只读")).toBeNull();
  });

  it.each([
    ["platform.runtime.environments", "环境实例 列表"],
    ["platform.governance.network-security", "网络与安全管理器"],
    ["platform.governance.system-prompts", "系统提示语管理器"],
    ["platform.governance.system-settings", "系统配置管理器"],
  ])("平台控制台叶子 %s 挂载可用页面", async (routeId, expected) => {
    render(
      <PlatformAdminShell
        renderTenants={() => <div />}
        renderModels={() => <div />}
        renderRemoteHands={() => <div />}
        renderToolControls={() => <div />}
        renderMemoryPolling={() => <div />}
        renderMcp={() => <div />}
        renderSkills={() => <div />}
        renderEfficiency={() => <div />}
        activeSection="overview"
        entityId={null}
        onSectionChange={() => undefined}
        settingsOpen={false}
        settingsSection="tenants"
        onSettingsSectionChange={() => undefined}
        onSettingsClose={() => undefined}
        governanceRoute={governanceRoute(routeId)}
        governanceContentOnly
      />,
    );
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.queryByText("只读")).toBeNull();
  });

  it.each([
    ["platform-admins", "平台管理员"],
    ["agent-templates", "智能体模板"],
    ["environment-templates", "环境模板"],
  ] as const)("统一设置入口 %s 挂载既有治理页面", async (settingsSection, expectedTitle) => {
    render(
      <PlatformAdminShell
        renderTenants={() => <div />}
        renderModels={() => <div />}
        renderRemoteHands={() => <div />}
        renderToolControls={() => <div />}
        renderMemoryPolling={() => <div />}
        renderMcp={() => <div />}
        renderSkills={() => <div />}
        renderEfficiency={() => <div />}
        activeSection="overview"
        entityId={null}
        onSectionChange={() => undefined}
        settingsOpen
        settingsContentOnly
        settingsSection={settingsSection}
        onSettingsSectionChange={() => undefined}
        onSettingsClose={() => undefined}
      />,
    );
    expect((await screen.findAllByText(expectedTitle)).length).toBeGreaterThan(0);
  });

  it("平台 Agent Template 叶子读取治理模板目录", async () => {
    render(<PlatformAdminShell
      renderTenants={() => <div />}
      renderModels={() => <div />}
      renderRemoteHands={() => <div />}
      renderToolControls={() => <div />}
      renderMemoryPolling={() => <div />}
      renderMcp={() => <div />}
      renderSkills={() => <div />}
      renderEfficiency={() => <div />}
      activeSection="overview"
      entityId={null}
      onSectionChange={() => undefined}
      settingsOpen={false}
      settingsSection="tenants"
      onSettingsSectionChange={() => undefined}
      onSettingsClose={() => undefined}
      governanceRoute={governanceRoute("platform.resource-center.agent-templates")}
      governanceContentOnly
    />);
    expect((await screen.findAllByText("template-1")).length).toBe(2);
  });

  it.each([
    ["organization.settings.general", "功能与配额", ["模型策略", "品牌", "安全"]],
    ["organization.settings.brand", "品牌", ["功能开关", "模型策略", "安全"]],
    ["organization.settings.security", "登录与安全", ["功能开关", "模型策略", "品牌"]],
    ["organization.agents.model-tools", "模型与工具", ["功能开关", "品牌", "安全"]],
  ])("组织设置叶子 %s 只渲染对应配置区块", (routeId, expectedTitle, unrelatedTitles) => {
    render(
      <TenantAdminShell
        {...commonTenantProps}
        renderUsers={() => <div />}
        governanceRoute={governanceRoute(routeId, { orgId: "acme" })}
      />,
    );
    expect(screen.getAllByText(expectedTitle).length).toBeGreaterThan(0);
    const page = screen.getByTestId("organization-management-content").querySelector("main");
    for (const title of unrelatedTitles) expect(page?.textContent).not.toContain(title);
  });
});
