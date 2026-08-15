import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { governanceRoute } from "@/lib/governanceNavigation";
import { PlatformAdminShell, TenantAdminShell } from "./AdminShells";

vi.mock("@agent/shared/lib/governanceApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agent/shared/lib/governanceApi")>();
  return {
    ...actual,
    governanceAccessApi: {
      ...actual.governanceAccessApi,
      listMemberships: vi.fn().mockResolvedValue({ memberships: [
        { userId: "member-1", persona: "member", isOwner: false, status: "active", version: 1, allowedActions: [] },
      ] }),
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
    user: { tenantId: "acme" },
    isPlatformAdmin: false,
    canPlatform: () => true,
  }),
}));
vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({ tenants: [{ id: "acme", name: "Acme" }] }),
}));
vi.mock("@/components/PlatformAdmin/pages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/PlatformAdmin/pages")>();
  return { ...actual, SandboxesPage: ({ sandboxName }: { sandboxName?: string | null }) => <div>环境实例 {sandboxName ?? "列表"}</div> };
});
vi.mock("@/components/EgressConfigManager", () => ({ default: () => <div>网络与安全管理器</div> }));
vi.mock("@/components/SystemPromptsManager", () => ({ default: () => <div>系统提示语管理器</div> }));
vi.mock("@/components/PlatformAdmin/SystemSettingsPanel", () => ({ SystemSettingsPanel: () => <div>系统配置管理器</div> }));
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
    for (const title of unrelatedTitles) expect(screen.queryByText(title)).toBeNull();
  });
});
