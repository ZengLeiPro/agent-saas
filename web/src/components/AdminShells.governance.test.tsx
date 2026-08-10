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
        { userId: "member-1", persona: "member", isOwner: false, status: "active", version: 1 },
      ] }),
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

  it("平台 Model 叶子复用现有 ModelManager 内容", () => {
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
    expect(screen.getByText("复用 ModelManager")).toBeTruthy();
  });
});
