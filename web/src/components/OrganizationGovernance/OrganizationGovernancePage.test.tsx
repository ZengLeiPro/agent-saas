import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { governanceRoute } from "@/lib/governanceNavigation";
import { OrganizationCredentialsPage, OrganizationGroupsPage, OrganizationMembersPage, OrganizationOffboardingPage } from "./OrganizationGovernancePage";

const mocks = vi.hoisted(() => ({
  listMemberships: vi.fn(), getMembershipDetails: vi.fn(), listDirectoryGroups: vi.fn(), listCredentials: vi.fn(), previewMembership: vi.fn(), updateMembership: vi.fn(), previewUserOffboarding: vi.fn(), startUserOffboarding: vi.fn(),
}));
vi.mock("@agent/shared/lib/governanceApi", () => ({
  governanceAccessApi: {
    listMemberships: mocks.listMemberships,
    getMembershipDetails: mocks.getMembershipDetails,
    listDirectoryGroups: mocks.listDirectoryGroups,
    previewMembership: mocks.previewMembership,
    updateMembership: mocks.updateMembership,
  },
  governanceResourcesApi: {
    listCredentials: mocks.listCredentials,
    previewUserOffboarding: mocks.previewUserOffboarding,
    startUserOffboarding: mocks.startUserOffboarding,
  },
}));

describe("OrganizationGovernancePage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("展示治理成员关系与所有者，不渲染旧角色开关", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [
      { userId: "owner-1", persona: "org_admin", isOwner: true, status: "active", version: 3, allowedActions: [] },
      { userId: "member-1", persona: "member", isOwner: false, status: "active", version: 1, allowedActions: [{ id: "promote_admin", label: "设为组织管理员", change: { persona: "org_admin" }, requiresReason: false }] },
    ] });
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />);
    expect(await screen.findByText("owner-1")).toBeTruthy();
    expect(screen.getByText("所有者")).toBeTruthy();
    expect(screen.getAllByText("启用").length).toBeGreaterThan(0);
    expect(screen.queryByText("active")).toBeNull();
    expect(screen.queryByRole("switch")).not.toBeTruthy();
  });

  it("所有者身份变更严格执行预览→提交", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [
      { userId: "owner-1", persona: "org_admin", isOwner: true, status: "active", version: 3, allowedActions: [] },
      { userId: "member-1", persona: "member", isOwner: false, status: "active", version: 1, allowedActions: [{ id: "promote_admin", label: "设为组织管理员", change: { persona: "org_admin" }, requiresReason: false }] },
    ] });
    mocks.previewMembership.mockResolvedValue({
      previewId: `mpv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64),
      expiresAt: "2099-08-10T10:00:00.000Z", expectedVersion: 1,
      impact: { from: { persona: "member", isOwner: false, status: "active" }, to: { persona: "org_admin", isOwner: false, status: "active" }, blockers: [], reversible: true, effectiveMode: "source_immediate_projection_pending" },
    });
    mocks.updateMembership.mockResolvedValue({
      userId: "member-1", persona: "org_admin", version: 2, changeId: "change-1", auditId: "audit-1",
      effectiveAt: "2026-08-10T10:00:01.000Z", projectionStatus: "pending", projectionId: "projection-1",
    });
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />);
    fireEvent.click(await screen.findByRole("button", { name: "设为组织管理员" }));
    fireEvent.change(screen.getByPlaceholderText("至少 3 个字符"), { target: { value: "业务管理员交接" } });
    fireEvent.click(screen.getByRole("button", { name: "生成影响预览" }));
    await waitFor(() => expect(mocks.previewMembership).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "确认变更" }));
    await waitFor(() => expect(mocks.updateMembership).toHaveBeenCalledWith("member-1", expect.objectContaining({
      expectedVersion: 1, persona: "org_admin", previewId: `mpv1.${"a".repeat(64)}`,
    }), "tenant-a"));
    expect(await screen.findByText("changeId：change-1")).toBeTruthy();
    expect(screen.getByText("auditId：audit-1")).toBeTruthy();
  });

  it("权威 API 失败时 fail closed", async () => {
    mocks.listMemberships.mockRejectedValue(new Error("503"));
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />);
    expect(await screen.findByText("权威治理结论暂不可获得")).toBeTruthy();
  });

  it("成员资源指派只渲染后端聚合，不在前端枚举推导", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [] });
    mocks.getMembershipDetails.mockResolvedValue({
      profile: { userId: "member-1", username: "member", displayName: "成员一", accountStatus: "active", dingtalkBound: false, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" },
      identity: { userId: "member-1", persona: "member", isOwner: false, status: "active", version: 1, allowedActions: [] },
      accessSummary: { effectivePersona: "member", owner: false, accountStatus: "active", decision: "eligible", why: [{ source: "membership", effect: "allow", version: 1 }] },
      assignments: [
        { resourceType: "skill", resources: [{ resourceId: "skill-1", bindingId: "binding-1", assignmentVersion: 2, finalEffect: "allow", bindings: [{ assignmentId: "binding-1", assigneeType: "user", assigneeId: "member-1", effect: "allow", origin: "direct" }] }] },
        { resourceType: "credential", resources: [] },
      ],
      snapshot: { membershipVersion: 1, generatedAt: "2099-08-10T10:00:00.000Z" },
    });
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.member", {
      orgId: "tenant-a", entityId: "member-1", tab: "assignments",
    })} />);
    expect(await screen.findByText("skill-1")).toBeTruthy();
    expect(screen.getByText(/Assignment v2/)).toBeTruthy();
    expect(mocks.getMembershipDetails).toHaveBeenCalledWith("member-1", "tenant-a");
  });

  it("组织群组展示本地不可变 ID 与外部来源，不复用个人会话分组", async () => {
    mocks.listDirectoryGroups.mockResolvedValue({ tenantId: "tenant-a", groups: [{
      groupId: "group-local-1", source: "dingtalk", externalGroupId: "dept-9",
      displayName: "销售部", status: "active", version: 2,
    }] });
    render(<OrganizationGroupsPage tenantId="tenant-a" />);
    expect(await screen.findByText("销售部")).toBeTruthy();
    expect(screen.getByText("group-local-1")).toBeTruthy();
    expect(screen.getByText("钉钉")).toBeTruthy();
    expect(screen.getByText("启用")).toBeTruthy();
  });

  it("离职交接必须先预览，只有无 blocker 才提交 Change Job", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [
      { userId: "user-leaving", persona: "member", isOwner: false, status: "active", version: 1, directoryProfile: { username: "leaving", displayName: "离职成员甲", accountStatus: "active" }, allowedActions: [] },
      { userId: "user-owner", persona: "org_admin", isOwner: true, status: "active", version: 2, directoryProfile: { username: "owner", displayName: "接手管理员乙", accountStatus: "active" }, allowedActions: [] },
    ] });
    mocks.previewUserOffboarding.mockResolvedValue({
      previewId: `opv1.${"a".repeat(64)}`, idempotencyKey: "offboard-server-key", baselineDigest: "b".repeat(64),
      expiresAt: "2099-08-10T10:05:00.000Z", impact: {
        membership: 1, agents: [], personalAgents: [], skills: [], personalCredentials: [], custodialCredentials: [],
        cronOwnership: { status: "clear", ids: [] }, personalMemory: { status: "clear", ids: [] },
        fileOwnership: { status: "clear", personalFileIds: [], organizationFileIds: [] },
      }, blockers: [], canCommit: true,
    });
    mocks.startUserOffboarding.mockResolvedValue({
      job: { jobId: "job-1", status: "pending", revision: 1, attempt: 0, createdAt: "2099-08-10T10:00:00.000Z", updatedAt: "2099-08-10T10:00:00.000Z" },
      domains: [{ domain: "credentials_connectors", status: "pending", totalCount: 0, completedCount: 0, failedCount: 0 }],
      created: true,
    });
    render(<OrganizationOffboardingPage tenantId="tenant-a" />);
    fireEvent.change(await screen.findByLabelText("离职成员"), { target: { value: "user-leaving" } });
    fireEvent.change(screen.getByLabelText("接手成员"), { target: { value: "user-owner" } });
    fireEvent.click(screen.getByText("生成影响预览"));
    expect(await screen.findByText("确认交接并撤权")).toBeTruthy();
    fireEvent.click(screen.getByText("确认交接并撤权"));
    await waitFor(() => expect(mocks.startUserOffboarding).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a", userId: "user-leaving", handoffTargetUserId: "user-owner",
      previewId: `opv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64),
    })));
    expect(await screen.findByText("变更任务")).toBeTruthy();
    expect(screen.getAllByText("等待中").length).toBeGreaterThan(0);
  });

  it("Credential 页面只展示安全字段", async () => {
    mocks.listCredentials.mockResolvedValue({ credentials: [{
      credentialId: "cred-1", connectorId: "github", alias: "发布凭据", purpose: "发布代码",
      kind: "org_shared", status: "active", generation: 2, version: 4,
    }, {
      credentialId: "cred-2", connectorId: "dingtalk", alias: "待轮换凭据", purpose: "发送通知",
      kind: "org_shared", status: "rotation_due", generation: 1, version: 2,
    }] });
    render(<OrganizationCredentialsPage tenantId="tenant-a" />);
    expect(await screen.findByText("发布凭据")).toBeTruthy();
    expect(screen.getByText("待轮换")).toBeTruthy();
    expect(screen.queryByText("rotation_due")).toBeNull();
    await waitFor(() => expect(screen.queryByText(/secretRef|vault:\/\//i)).not.toBeTruthy());
    expect(screen.queryByRole("button", { name: /撤销|轮换|测试/ })).not.toBeTruthy();
  });
});
