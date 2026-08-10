import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { governanceRoute } from "@/lib/governanceNavigation";
import { OrganizationCredentialsPage, OrganizationMembersPage } from "./OrganizationGovernancePage";

const mocks = vi.hoisted(() => ({
  listMemberships: vi.fn(), listCredentials: vi.fn(), previewMembership: vi.fn(), updateMembership: vi.fn(),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { id: "owner-1" } }) }));
vi.mock("@agent/shared/lib/governanceApi", () => ({
  governanceAccessApi: {
    listMemberships: mocks.listMemberships,
    previewMembership: mocks.previewMembership,
    updateMembership: mocks.updateMembership,
  },
  governanceResourcesApi: { listCredentials: mocks.listCredentials },
}));

describe("OrganizationGovernancePage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("展示治理 Membership 与 Owner，不渲染 legacy role 开关", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [
      { userId: "owner-1", persona: "org_admin", isOwner: true, status: "active", version: 3 },
      { userId: "member-1", persona: "member", isOwner: false, status: "active", version: 1 },
    ] });
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />);
    expect(await screen.findByText("owner-1")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.queryByRole("switch")).not.toBeTruthy();
  });

  it("Owner 身份变更严格执行 preview→commit", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [
      { userId: "owner-1", persona: "org_admin", isOwner: true, status: "active", version: 3 },
      { userId: "member-1", persona: "member", isOwner: false, status: "active", version: 1 },
    ] });
    mocks.previewMembership.mockResolvedValue({
      previewId: `mpv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64),
      expiresAt: "2026-08-10T10:00:00.000Z", expectedVersion: 1,
    });
    mocks.updateMembership.mockResolvedValue({ userId: "member-1", persona: "org_admin", version: 2 });
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />);
    fireEvent.click(await screen.findByRole("button", { name: "设为组织管理员" }));
    fireEvent.change(screen.getByPlaceholderText("至少 3 个字符"), { target: { value: "业务管理员交接" } });
    fireEvent.click(screen.getByRole("button", { name: "生成影响预览" }));
    await waitFor(() => expect(mocks.previewMembership).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "确认变更" }));
    await waitFor(() => expect(mocks.updateMembership).toHaveBeenCalledWith("member-1", expect.objectContaining({
      expectedVersion: 1, persona: "org_admin", previewId: `mpv1.${"a".repeat(64)}`,
    }), "tenant-a"));
  });

  it("权威 API 失败时 fail closed", async () => {
    mocks.listMemberships.mockRejectedValue(new Error("503"));
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />);
    expect(await screen.findByText("权威治理结论暂不可获得")).toBeTruthy();
  });

  it("Credential 页面只展示安全字段", async () => {
    mocks.listCredentials.mockResolvedValue({ credentials: [{
      credentialId: "cred-1", connectorId: "github", alias: "发布凭据", purpose: "发布代码",
      kind: "org_shared", status: "active", generation: 2, version: 4,
    }] });
    render(<OrganizationCredentialsPage tenantId="tenant-a" />);
    expect(await screen.findByText("发布凭据")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/secretRef|vault:\/\//i)).not.toBeTruthy());
    expect(screen.queryByRole("button", { name: /撤销|轮换|测试/ })).not.toBeTruthy();
  });
});
