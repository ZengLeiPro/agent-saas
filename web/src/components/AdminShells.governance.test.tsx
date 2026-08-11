import { render, screen } from "@testing-library/react";
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

  it("平台 Model 叶子在治理写合同未闭合时保持只读", () => {
    render(
      <PlatformAdminShell
        renderTenants={() => <div>复用 TenantManager</div>}
        renderModels={() => <div>复用 ModelManager</div>}
        renderRemoteHands={() => <div>复用 ExecutionProvider</div>}
        renderToolControls={() => <div>复用 ToolControls</div>}
        renderMemoryPolling={() => <div>复用 MemoryPolicy</div>}
        renderMcp={() => <div>复用 Connector Catalog</div>}
        renderSkills={() => <div>复用 SkillManager</div>}
        renderEfficiency={() => <div>复用 Efficiency</div>}
        activeSection="overview"
        entityId={null}
        onSectionChange={() => undefined}
        settingsOpen={false}
        settingsSection="tenants"
        onSettingsSectionChange={() => undefined}
        onSettingsClose={() => undefined}
        governanceRoute={governanceRoute("platform.resource-center.models")}
        governanceContentOnly
      />,
    );
    expect(screen.getByText("Model 目录")).toBeTruthy();
    expect(screen.getByText("只读")).toBeTruthy();
    expect(screen.queryByText("复用 ModelManager")).not.toBeTruthy();
  });

  it.each([
    ["platform.runtime.execution-providers", "Execution Provider"],
    ["platform.runtime.environments", "Environment Instance"],
    ["platform.governance.network-security", "网络安全"],
    ["platform.governance.system-prompts", "系统提示语"],
    ["platform.governance.memory-policy", "Memory Policy"],
    ["platform.governance.system-settings", "系统设置"],
  ])("平台 V2 叶子 %s 在写合同未闭合时只挂只读提示", (routeId, title) => {
    const renderRemoteHands = vi.fn(() => <div>旧 Execution Provider 写组件</div>);
    const renderMemoryPolling = vi.fn(() => <div>旧 Memory Policy 写组件</div>);
    render(
      <PlatformAdminShell
        renderTenants={() => <div>旧 Tenant 写组件</div>}
        renderModels={() => <div>旧 Model 写组件</div>}
        renderRemoteHands={renderRemoteHands}
        renderToolControls={() => <div>旧 Tool 写组件</div>}
        renderMemoryPolling={renderMemoryPolling}
        renderMcp={() => <div>旧 Connector 写组件</div>}
        renderSkills={() => <div>旧 Skill 写组件</div>}
        renderEfficiency={() => <div>旧 Efficiency 写组件</div>}
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
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText("只读")).toBeTruthy();
    expect(renderRemoteHands).not.toHaveBeenCalled();
    expect(renderMemoryPolling).not.toHaveBeenCalled();
    expect(screen.queryByText(/旧 .*写组件/)).toBeNull();
    expect(screen.queryByText(/authTokenRef/i)).toBeNull();
    expect(screen.queryByLabelText(/token/i)).toBeNull();
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
});
