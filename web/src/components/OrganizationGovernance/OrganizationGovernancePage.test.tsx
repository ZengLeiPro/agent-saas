import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { governanceRoute } from "@/lib/governanceNavigation";
import { DEFAULT_TENANT_SETTINGS } from "@/components/TenantManager/types";
import { SettingsDirtyBoundary } from "@/components/PersonalSettings/dirtyRegistry";
import { OrganizationCredentialsPage, OrganizationEnvironmentsPage, OrganizationGroupsPage, OrganizationMemoryKnowledgePage, OrganizationMembersPage, OrganizationOffboardingPage, OrganizationPoliciesPage } from "./OrganizationGovernancePage";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(), listMemberships: vi.fn(), createMembership: vi.fn(), getMembershipDetails: vi.fn(), listDirectoryGroups: vi.fn(), getAssignment: vi.fn(), listCredentials: vi.fn(), listConnectors: vi.fn(), listEntitlementResourceCatalog: vi.fn(), getEntitlements: vi.fn(), getTenantSettings: vi.fn(), updateTenantSettings: vi.fn(), listMemoryKnowledge: vi.fn(), listEnvironmentTemplates: vi.fn(),
  previewMembership: vi.fn(), updateMembership: vi.fn(), previewUserOffboarding: vi.fn(), startUserOffboarding: vi.fn(), previewPolicy: vi.fn(), updatePolicy: vi.fn(), previewMemoryResource: vi.fn(), updateMemoryResource: vi.fn(), previewAssignment: vi.fn(), updateAssignment: vi.fn(), previewAssignmentBatch: vi.fn(), updateAssignmentBatch: vi.fn(),
  previewEntitlementScope: vi.fn(), updateEntitlementScope: vi.fn(), previewCredentialCreate: vi.fn(), createCredential: vi.fn(), previewCredentialRotation: vi.fn(), rotateCredential: vi.fn(), previewCredentialTransfer: vi.fn(), transferCredential: vi.fn(), testCredentialHealth: vi.fn(),
}));

const authState = vi.hoisted(() => ({ isAdmin: true, username: "org-admin" }));
const authFetchMock = vi.hoisted(() => vi.fn());

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: {
      id: "admin-1",
      username: authState.username,
      tenantId: "tenant-a",
      role: authState.isAdmin ? "admin" : "user",
    },
    isAdmin: authState.isAdmin,
    isPlatformAdmin: false,
  }),
}));

vi.mock("@/lib/authFetch", () => ({ authFetch: authFetchMock }));

vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({ tenants: [], loading: false }),
}));

vi.mock("@agent/shared/lib/governanceApi", () => ({
  contextCenterApi: {
    getSnapshot: mocks.getSnapshot,
    getEvidence: vi.fn().mockResolvedValue([]),
    listTimeline: vi.fn().mockResolvedValue({ items: [], nextCursor: null, degraded: false }),
    listEntities: vi.fn().mockResolvedValue({ items: [], nextCursor: null, degraded: false }),
    getEntity: vi.fn(),
    listEntityItems: vi.fn().mockResolvedValue({ items: [], nextCursor: null, degraded: false }),
    listEntityCorrections: vi.fn().mockResolvedValue({ items: [], nextCursor: null, degraded: false }),
    getEntityProfile: vi.fn(),
    listEntityRelations: vi.fn().mockResolvedValue({ items: [], nextCursor: null, degraded: false }),
    listReviews: vi.fn().mockResolvedValue({ items: [], nextCursor: null, degraded: false }),
    createCorrection: vi.fn(),
    decideReview: vi.fn(),
  },
  governanceAccessApi: {
    listMemberships: mocks.listMemberships,
    createMembership: mocks.createMembership,
    getMembershipDetails: mocks.getMembershipDetails,
    listDirectoryGroups: mocks.listDirectoryGroups,
    getAssignment: mocks.getAssignment,
    previewMembership: mocks.previewMembership,
    updateMembership: mocks.updateMembership,
    getEntitlements: mocks.getEntitlements,
    getTenantSettings: mocks.getTenantSettings,
    updateTenantSettings: mocks.updateTenantSettings,
    listMemoryKnowledge: mocks.listMemoryKnowledge,
    previewMemoryResource: mocks.previewMemoryResource,
    updateMemoryResource: mocks.updateMemoryResource,
    previewAssignment: mocks.previewAssignment,
    updateAssignment: mocks.updateAssignment,
    previewAssignmentBatch: mocks.previewAssignmentBatch,
    updateAssignmentBatch: mocks.updateAssignmentBatch,
    previewPolicy: mocks.previewPolicy,
    updatePolicy: mocks.updatePolicy,
    previewEntitlementScope: mocks.previewEntitlementScope,
    updateEntitlementScope: mocks.updateEntitlementScope,
  },
  governanceResourcesApi: {
    listCredentials: mocks.listCredentials,
    listConnectors: mocks.listConnectors,
    listEntitlementResourceCatalog: mocks.listEntitlementResourceCatalog,
    listEnvironmentTemplates: mocks.listEnvironmentTemplates,
    previewCredentialCreate: mocks.previewCredentialCreate,
    createCredential: mocks.createCredential,
    previewCredentialRotation: mocks.previewCredentialRotation,
    rotateCredential: mocks.rotateCredential,
    previewCredentialTransfer: mocks.previewCredentialTransfer,
    transferCredential: mocks.transferCredential,
    testCredentialHealth: mocks.testCredentialHealth,
    previewUserOffboarding: mocks.previewUserOffboarding,
    startUserOffboarding: mocks.startUserOffboarding,
  },
}));

function renderWithDirtyNavigation(page: ReactNode) {
  const navigated = vi.fn();
  render(<SettingsDirtyBoundary>{(controller) => <>{page}<button type="button" onClick={() => controller.requestNavigation(navigated)}>切换组织页面</button></>}</SettingsDirtyBoundary>);
  return navigated;
}

describe("OrganizationGovernancePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, "", "/");
    authState.isAdmin = true;
    authState.username = "org-admin";
    mocks.listMemberships.mockResolvedValue({ memberships: [] });
    mocks.listDirectoryGroups.mockResolvedValue({ groups: [] });
    mocks.getAssignment.mockResolvedValue({ version: 0, assignments: [] });
    mocks.listEntitlementResourceCatalog.mockResolvedValue({ resourceType: "connector", items: [] });
    mocks.getEntitlements.mockResolvedValue({ entitlement: null, scopes: [], policies: [] });
    authFetchMock.mockResolvedValue(new Response(JSON.stringify([]), { status: 200,
      headers: { "Content-Type": "application/json" } }));
    mocks.listConnectors.mockResolvedValue({ connectors: [] });
    mocks.getSnapshot.mockResolvedValue({ generatedAt: "2026-08-22T15:40:00.000Z", sources: [], consumers: [] });
    mocks.listMemberships.mockResolvedValue({ memberships: [] });
    mocks.listDirectoryGroups.mockResolvedValue({ groups: [] });
    mocks.getTenantSettings.mockResolvedValue({
      tenantId: "tenant-a",
      settings: { ...structuredClone(DEFAULT_TENANT_SETTINGS), features: { ...structuredClone(DEFAULT_TENANT_SETTINGS.features), debugModeAllowed: true, debugModeEnabled: true } },
      updatedAt: "2026-08-18T07:00:00.000Z",
    });
    mocks.updateTenantSettings.mockResolvedValue({
      tenantId: "tenant-a",
      settings: { ...structuredClone(DEFAULT_TENANT_SETTINGS), features: { ...structuredClone(DEFAULT_TENANT_SETTINGS.features), debugModeAllowed: true, debugModeEnabled: false } },
      updatedAt: "2026-08-18T07:01:00.000Z",
    });
  });

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

  it("管理员在成员页通过治理 API 新增成员，组织范围锁定并刷新列表", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [] });
    mocks.createMembership.mockResolvedValue({ userId: "user-9" });
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />);
    fireEvent.click(await screen.findByRole("button", { name: /添加成员/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "new-member" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(mocks.createMembership).toHaveBeenCalledWith(
      expect.objectContaining({ username: "new-member", password: "secret123", role: "user" }),
      "tenant-a",
    ));
    expect(mocks.createMembership.mock.calls[0][0]).not.toHaveProperty("tenantId");
    await waitFor(() => expect(mocks.listMemberships.mock.calls.length).toBeGreaterThan(1));
  });

  it("无成员管理权限的账号看到权限原因与指引，而不是静默隐藏", async () => {
    authState.isAdmin = false;
    authState.username = "plain-member";
    mocks.listMemberships.mockResolvedValue({ memberships: [] });
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />);
    expect(await screen.findByText(/没有成员管理权限/)).toBeTruthy();
    expect(screen.getByText(/请联系本组织管理员或平台管理员/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /添加成员/ })).toBeNull();
    expect(mocks.createMembership).not.toHaveBeenCalled();
  });

  it("添加成员失败时在对话框内展示治理 API 错误且不关闭", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [] });
    mocks.createMembership.mockRejectedValue(new Error("用户名已存在"));
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />);
    fireEvent.click(await screen.findByRole("button", { name: /添加成员/ }));
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "dup-member" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText("用户名已存在")).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("成员关系重复时展示中文恢复指引而不是内部错误码", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [] });
    const error = Object.assign(new Error("MEMBERSHIP_ALREADY_EXISTS"), { code: "MEMBERSHIP_ALREADY_EXISTS" });
    mocks.createMembership.mockRejectedValue(error);
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />);
    fireEvent.click(await screen.findByRole("button", { name: /添加成员/ }));
    fireEvent.change(screen.getByLabelText("用户名"), { target: { value: "existing-member" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret123" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(await screen.findByText(/组织成员关系已存在/)).toBeTruthy();
    expect(screen.getByText(/成员已停用.*恢复/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
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

  it("成员身份弹窗自身取消时经过 dirty guard", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [
      { userId: "member-1", persona: "member", isOwner: false, status: "active", version: 1, allowedActions: [{ id: "promote_admin", label: "设为组织管理员", change: { persona: "org_admin" }, requiresReason: false }] },
    ] });
    render(
      <SettingsDirtyBoundary>
        {() => <OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />}
      </SettingsDirtyBoundary>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "设为组织管理员" }));
    fireEvent.change(screen.getByPlaceholderText("至少 3 个字符"), { target: { value: "业务管理员交接" } });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(await screen.findByRole("heading", { name: "有未保存的更改" })).toBeTruthy();
    expect(screen.getByDisplayValue("业务管理员交接")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "放弃更改" }));
    await waitFor(() => expect(screen.queryByDisplayValue("业务管理员交接")).toBeNull());
  });

  it("权威 API 失败时 fail closed", async () => {
    mocks.listMemberships.mockRejectedValue(new Error("503"));
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.list", { orgId: "tenant-a" })} />);
    expect(await screen.findByText("权限服务暂不可用")).toBeTruthy();
  });

  it("成员详情的身份与权限页可更新个人调试模式", async () => {
    authFetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ debugMode: true }) });
    mocks.getMembershipDetails.mockResolvedValue({
      profile: { userId: "member-1", username: "member", displayName: "成员一", accountStatus: "active", dingtalkBound: false, debugMode: false, debugModeAvailable: true, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" },
      identity: { userId: "member-1", persona: "member", isOwner: false, status: "active", version: 1, allowedActions: [] },
      accessSummary: { effectivePersona: "member", owner: false, accountStatus: "active", decision: "eligible", why: [{ source: "membership", effect: "allow", version: 1 }] },
      assignments: [], usagePolicy: { status: "unavailable" }, recentAudit: { events: [], coverage: "recent_membership_endpoint_events", limit: 100 },
      snapshot: { membershipVersion: 1, generatedAt: "2099-08-10T10:00:00.000Z" },
    });
    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.member", {
      orgId: "tenant-a", entityId: "member-1", tab: "access",
    })} />);

    fireEvent.click(await screen.findByRole("switch", { name: "成员个人调试模式" }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledWith("/api/auth/users/member-1", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ debugMode: true }),
    })));
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

  it("成员用量策略仅显示北京时间周期、成员已归属用量、个人限额与启动权限", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [] });
    mocks.getMembershipDetails.mockResolvedValue({
      profile: { userId: "member-1", username: "member", displayName: "成员一", accountStatus: "active", dingtalkBound: false, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" },
      identity: { userId: "member-1", persona: "member", isOwner: false, status: "active", version: 1, allowedActions: [] },
      accessSummary: { effectivePersona: "member", owner: false, accountStatus: "active", decision: "eligible", why: [] },
      assignments: [],
      usagePolicy: {
        tenantId: "tenant-a", timezone: "Asia/Shanghai",
        periodStart: "2026-07-31T16:00:00.000Z", periodEnd: "2026-08-31T16:00:00.000Z",
        items: [{ userId: "member-1", enforcementMode: "notify", active: true, version: 1, monthlyLimitCreditsMicro: 500, monthAttributedCreditsMicro: 125, canStartRun: true }],
      },
      recentAudit: { events: [], coverage: "recent_membership_endpoint_events", limit: 100 },
      snapshot: { membershipVersion: 1, generatedAt: "2026-08-10T00:00:00.000Z" },
    });

    render(<OrganizationMembersPage tenantId="tenant-a" route={governanceRoute("organization.members.member", {
      orgId: "tenant-a", entityId: "member-1", tab: "usage-policy",
    })} />);

    expect(await screen.findByText("2026年8月（北京时间）")).toBeTruthy();
    expect(screen.getByText("成员本月已归属用量")).toBeTruthy();
    expect(screen.getByText("个人月限额")).toBeTruthy();
    expect(screen.getByText("允许启动")).toBeTruthy();
    expect(screen.getByText("125")).toBeTruthy();
    expect(screen.getByText("500")).toBeTruthy();
    expect(screen.queryByText("组织未归属用量")).toBeNull();
    expect(screen.queryByText(/2026-07-31T16:00:00/)).toBeNull();
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

  it("离职交接草稿在切换页面前触发 dirty guard", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [
      { userId: "user-leaving", persona: "member", isOwner: false, status: "active", version: 1, directoryProfile: { username: "leaving", displayName: "离职成员甲", accountStatus: "active" }, allowedActions: [] },
      { userId: "user-next", persona: "member", isOwner: false, status: "active", version: 1, directoryProfile: { username: "next", displayName: "接手成员乙", accountStatus: "active" }, allowedActions: [] },
    ] });
    const navigated = renderWithDirtyNavigation(<OrganizationOffboardingPage tenantId="tenant-a" />);
    fireEvent.change(await screen.findByLabelText("离职成员"), { target: { value: "user-leaving" } });
    fireEvent.click(screen.getByRole("button", { name: "切换组织页面" }));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(navigated).not.toHaveBeenCalled();
  });

  it("离职预览即使错误返回 canCommit=true，未知 authority 仍禁用按钮并阻止提交", async () => {
    mocks.listMemberships.mockResolvedValue({ memberships: [
      { userId: "user-leaving", persona: "member", isOwner: false, status: "active", version: 1, allowedActions: [] },
      { userId: "user-owner", persona: "org_admin", isOwner: true, status: "active", version: 2, allowedActions: [] },
    ] });
    mocks.previewUserOffboarding.mockResolvedValue({
      previewId: `opv1.${"a".repeat(64)}`, idempotencyKey: "offboard-unknown", baselineDigest: "b".repeat(64),
      expiresAt: "2099-08-10T10:05:00.000Z", blockers: [], canCommit: true,
      impact: {
        membership: 1, agents: [], personalAgents: [], skills: [], personalCredentials: [], custodialCredentials: [],
        cronOwnership: { status: "unknown", ids: [] }, personalMemory: { status: "clear", ids: [] },
        fileOwnership: { status: "clear", personalFileIds: [], organizationFileIds: [] },
      },
    });

    render(<OrganizationOffboardingPage tenantId="tenant-a" />);
    fireEvent.change(await screen.findByLabelText("离职成员"), { target: { value: "user-leaving" } });
    fireEvent.change(screen.getByLabelText("接手成员"), { target: { value: "user-owner" } });
    fireEvent.click(screen.getByText("生成影响预览"));

    expect(await screen.findByText(/定时任务归属权威状态未知或暂不可用/)).toBeTruthy();
    const commitButton = screen.getByRole("button", { name: "确认交接并撤权" }) as HTMLButtonElement;
    expect(commitButton.disabled).toBe(true);
    fireEvent.click(commitButton);
    expect(mocks.startUserOffboarding).not.toHaveBeenCalled();
  });

  it("Credential 页面只展示安全字段", async () => {
    mocks.listConnectors.mockResolvedValue({ connectors: [{ connectorId: "github", name: "GitHub", status: "published", authMethods: ["token"], version: 1, healthTestSupported: true }, { connectorId: "dingtalk", name: "钉钉", status: "published", authMethods: ["oauth"], version: 1, healthTestSupported: false }] });
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
    expect(screen.getByRole("button", { name: "真实健康测试" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "健康测试无安全合同" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/secretRef|vault:\/\//i)).not.toBeTruthy();
  });

  it("组织策略页提供成员调试模式开关并沿用组织设置接口", async () => {
    mocks.getEntitlements.mockResolvedValue({ entitlement: null, scopes: [], policies: [{ policyKey: "runtime.debug_mode.allowed", value: true, source: "legacy_projection", version: 1 }, { policyKey: "runtime.debug_mode.enabled", value: true, source: "legacy_projection", version: 1 }] });
    render(<OrganizationPoliciesPage tenantId="tenant-a" />);

    fireEvent.click(await screen.findByRole("switch", { name: "成员调试模式" }));

    await waitFor(() => expect(mocks.updateTenantSettings).toHaveBeenCalledWith("tenant-a", expect.objectContaining({
      settings: expect.objectContaining({ features: expect.objectContaining({ debugModeAllowed: true, debugModeEnabled: false }) }),
    })));
    expect(screen.queryByLabelText("runtime.debug_mode.allowed 策略")).toBeNull();
  });

  it("组织策略以业务语义展示，并按需展开 preview→commit", async () => {
    mocks.getEntitlements.mockResolvedValue({ entitlement: { source: "plan_default", status: "active", limits: {}, version: 1 }, scopes: [], policies: [{
      policyKey: "knowledge.org.enabled", value: true, source: "legacy_projection", version: 3,
      definition: { label: "组织知识库", description: "允许成员访问组织知识。", group: "knowledge_memory", groupLabel: "知识与记忆", valueType: "boolean" },
      allowedActions: [{ id: "edit_policy" }],
    }] });
    mocks.previewPolicy.mockResolvedValue({ previewId: `gpv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", impact: { from: "allow", to: "deny" }, changeId: "intent-1" });
    mocks.updatePolicy.mockResolvedValue({ changeId: "change-1", auditId: "audit-1", effectiveAt: "2026-08-14T00:00:00.000Z" });
    render(<OrganizationPoliciesPage tenantId="tenant-a" />);

    expect(await screen.findByText("组织知识库")).toBeTruthy();
    expect(screen.getAllByText("知识与记忆").length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("knowledge.org.enabled 变更原因")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "修改组织知识库" }));
    fireEvent.click(screen.getByRole("button", { name: "禁止" }));
    fireEvent.change(screen.getByLabelText("knowledge.org.enabled 变更原因"), { target: { value: "安全收敛" } });
    fireEvent.click(screen.getByRole("button", { name: "预览变更" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认应用" }));
    await waitFor(() => expect(mocks.updatePolicy).toHaveBeenCalledWith("knowledge.org.enabled", expect.objectContaining({ expectedVersion: 3, value: false, previewId: `gpv1.${"a".repeat(64)}` }), "tenant-a"));
  });

  it("非 boolean 策略保持只读，并可按名称搜索和来源筛选", async () => {
    mocks.getEntitlements.mockResolvedValue({ entitlement: null, scopes: [], policies: [{
      policyKey: "runtime.high_risk_tool.mode", value: "approval", source: "governance", version: 2,
      definition: { label: "高风险工具审批", description: "高风险工具必须审批。", group: "security_session", groupLabel: "安全与会话", valueType: "enum", options: [{ value: "approval", label: "要求审批" }] },
      allowedActions: [{ id: "edit_policy" }],
    }, {
      policyKey: "skill.custom.enabled", value: true, source: "legacy_projection", version: 1,
      definition: { label: "自定义技能", description: "允许组织创建 Skill。", group: "models_tools", groupLabel: "模型与工具", valueType: "boolean" },
      allowedActions: [{ id: "edit_policy" }],
    }] });
    render(<OrganizationPoliciesPage tenantId="tenant-a" />);

    expect(await screen.findByText("高风险工具审批")).toBeTruthy();
    expect(screen.getByText("要求审批")).toBeTruthy();
    expect(screen.getByText(/当前页面只读/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "修改高风险工具审批" })).toBeNull();

    fireEvent.change(screen.getByLabelText("搜索权限策略"), { target: { value: "自定义技能" } });
    expect(screen.getByText("自定义技能")).toBeTruthy();
    expect(screen.queryByText("高风险工具审批")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "仅看组织覆盖" }));
    expect(screen.getByText("当前筛选条件下没有权限策略。")).toBeTruthy();
    expect(mocks.previewPolicy).not.toHaveBeenCalled();
  });

  it("记忆与知识入口扩展 Context 产品页签且不创建额外壳层", async () => {
    mocks.listMemoryKnowledge.mockResolvedValue({ tenantId: "tenant-a", authority: "governance_assignment_sets", accessMode: "manage", suites: [], knowledge: [], memory: [], effective: { organizationKnowledge: false, organizationMemory: false } });
    render(<OrganizationMemoryKnowledgePage tenantId="tenant-a" />);
    await screen.findByText("当前组织没有组织知识资源。");
    const tabs = screen.getByRole("tablist", { name: "记忆与知识区域" });
    expect(Array.from(tabs.querySelectorAll('[role="tab"]')).map(tab => tab.textContent)).toEqual(["资源治理", "Context Center", "Timeline", "实体", "待审核"]);
    expect(tabs.className).toContain("overflow-x-auto");
    expect(tabs.className).toContain("flex-nowrap");
    expect(tabs.className).toContain("sm:flex-wrap");
    for (const tab of Array.from(tabs.querySelectorAll('[role="tab"]'))) expect(tab.className).toContain("shrink-0");
  });

  it("记忆与知识深链绑定租户并恢复页签与筛选", async () => {
    const user = userEvent.setup();
    mocks.listMemoryKnowledge.mockResolvedValue({ tenantId: "tenant-a", authority: "governance_assignment_sets", accessMode: "manage", suites: [], knowledge: [], memory: [], effective: { organizationKnowledge: false, organizationMemory: false } });
    const first = render(<OrganizationMemoryKnowledgePage tenantId="tenant-a" />);
    await user.click(await screen.findByRole("tab", { name: "Timeline" }));
    fireEvent.change(await screen.findByLabelText("Timeline 筛选"), { target: { value: "task" } });
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));
    await waitFor(() => {
      const params = new URLSearchParams(window.location.search);
      expect(params.get("contextTenant")).toBe("tenant-a");
      expect(params.get("contextView")).toBe("timeline");
      expect(params.get("contextFilter")).toBe("task");
    });
    first.unmount();
    render(<OrganizationMemoryKnowledgePage tenantId="tenant-a" />);
    expect(screen.getByRole("tab", { name: "Timeline" }).getAttribute("data-state")).toBe("active");
    expect((screen.getByLabelText("Timeline 筛选") as HTMLInputElement).value).toBe("task");
  });

  it("不同租户不继承 Context 深链且同页实例跟随 URL 同步", async () => {
    const user = userEvent.setup();
    mocks.listMemoryKnowledge.mockResolvedValue({ tenantId: "tenant-a", authority: "governance_assignment_sets", accessMode: "manage", suites: [], knowledge: [], memory: [], effective: { organizationKnowledge: false, organizationMemory: false } });
    window.history.replaceState({}, "", "/?contextTenant=tenant-a&contextView=entities&contextFilter=project");
    render(<><OrganizationMemoryKnowledgePage tenantId="tenant-a" /><OrganizationMemoryKnowledgePage tenantId="tenant-a" /></>);
    expect(screen.getAllByRole("tab", { name: "实体" }).every(tab => tab.getAttribute("data-state") === "active")).toBe(true);
    await user.click(screen.getAllByRole("tab", { name: "Timeline" })[0]!);
    await waitFor(() => expect(screen.getAllByRole("tab", { name: "Timeline" })
      .every(tab => tab.getAttribute("data-state") === "active")).toBe(true));
    window.history.replaceState({}, "", "/?contextTenant=tenant-a&contextView=entities");
    window.dispatchEvent(new PopStateEvent("popstate"));
    const tenantB = render(<OrganizationMemoryKnowledgePage tenantId="tenant-b" />);
    expect(tenantB.container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("资源治理");
  });

  it("Taskboard 套件通过姓名和部门选择后一次预览并原子提交三个 Collection", async () => {
    const resources = ["taskboard-projects", "taskboard-tasks", "taskboard-events"].map((resourceId, index) => ({ resourceId, name: resourceId, version: index + 1, status: "enabled" as const }));
    mocks.listMemoryKnowledge.mockResolvedValue({
      tenantId: "tenant-a", authority: "governance_assignment_sets", accessMode: "manage",
      suites: [{ suiteId: "taskboard", name: "Taskboard 项目与任务", description: "项目、任务和变更历史原子授权。",
        policyEnabled: true, resourceIds: resources.map(item => item.resourceId),
        expectedResourceIds: resources.map(item => item.resourceId), missingResourceIds: [], unknownResourceIds: [],
        completeness: "complete", resources,
        configuration: { mode: "none", userIds: [], groupIds: [] } }],
      knowledge: resources.map(item => ({ ...item, policyEnabled: true, scope: [], source: "governance", updatedAt: "2026-08-14T00:00:00.000Z" })),
      memory: [], effective: { organizationKnowledge: true, organizationMemory: false },
    });
    mocks.listMemberships.mockResolvedValue({ memberships: [{ userId: "user-1", status: "active", directoryProfile: { displayName: "曾磊", username: "zenglei" } }] });
    mocks.listDirectoryGroups.mockResolvedValue({ groups: [{ groupId: "dept-rd", displayName: "研发部", status: "active" }] });
    mocks.previewAssignmentBatch.mockResolvedValue({ previewId: `abpv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z",
      changes: resources.map(item => ({ resourceId: item.resourceId, before: [], after: [
        { assigneeType: "user", assigneeId: "user-1", effect: "allow", label: "曾磊" },
        { assigneeType: "directory_group", assigneeId: "dept-rd", effect: "allow", label: "研发部" },
      ], addedCount: 2, removedCount: 0, beforeUserCount: 0, afterUserCount: 1,
        addedUserCount: 1, removedUserCount: 0 })), impact: { resourceCount: 3, directSubjectCount: 2,
        effectiveUserCount: 1, addedUserCount: 1, removedUserCount: 0, agentRuleCount: 0,
        atomic: true, requiresNewSession: true } });
    mocks.updateAssignmentBatch.mockResolvedValue({ sets: resources.map(item => ({ resourceId: item.resourceId, version: item.version + 1 })), auditId: "audit-batch", effectiveAt: "2026-08-25T12:00:00.000Z" });

    render(<OrganizationMemoryKnowledgePage tenantId="tenant-a" />);
    expect(await screen.findByText("接入什么数据")).toBeTruthy();
    fireEvent.click(await screen.findByLabelText(/曾磊/));
    fireEvent.click(await screen.findByLabelText(/研发部/));
    fireEvent.click(screen.getByRole("button", { name: "预览完整差异" }));
    await waitFor(() => expect(mocks.previewAssignmentBatch).toHaveBeenCalledWith(expect.objectContaining({
      changes: expect.arrayContaining([expect.objectContaining({ resourceId: "taskboard-projects",
        assignments: expect.arrayContaining([expect.objectContaining({ assigneeId: "user-1" }), expect.objectContaining({ assigneeId: "dept-rd" })]) })]),
    }), "tenant-a"));
    expect(await screen.findByText(/原子边界/)).toBeTruthy();
    expect(screen.getAllByText(/曾磊（user-1）/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "原子提交 3 个 Collection" }));
    await waitFor(() => expect(mocks.updateAssignmentBatch).toHaveBeenCalled());
    expect(await screen.findByText(/需新建 Agent 会话验收/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "新建 Agent 会话" }).getAttribute("href")).toBe("/");
  });

  it("记忆知识页使用组织权威元数据并可 signed preview→commit 创建 memory", async () => {
    mocks.listMemoryKnowledge.mockResolvedValue({ tenantId: "tenant-a", authority: "governance_assignment_sets", accessMode: "manage", suites: [], knowledge: [], memory: [], effective: { organizationKnowledge: false, organizationMemory: false } });
    mocks.previewMemoryResource.mockResolvedValue({ previewId: `mrpv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", impact: { operation: "create" }, changeId: "intent-1" });
    mocks.updateMemoryResource.mockResolvedValue({ changeId: "change-1", auditId: "audit-1", effectiveAt: "2026-08-14T00:00:00.000Z", version: 1 });
    render(<OrganizationMemoryKnowledgePage tenantId="tenant-a" />);
    expect(await screen.findByText("当前组织没有组织知识资源。")).toBeTruthy();
    expect(screen.getByText("当前组织没有组织记忆资源。")).toBeTruthy();
    expect(screen.queryByText(/个人记忆资源/)).toBeNull();
    fireEvent.change(screen.getByLabelText("记忆资源 ID"), { target: { value: "team-decisions" } });
    fireEvent.change(screen.getByLabelText("team-decisions记忆名称"), { target: { value: "团队决策" } });
    fireEvent.change(screen.getByLabelText("team-decisions记忆变更原因"), { target: { value: "建立组织记忆" } });
    const previewButton = screen.getByRole("button", { name: "生成签名预览" });
    await waitFor(() => expect((previewButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(previewButton);
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    await waitFor(() => expect(mocks.updateMemoryResource).toHaveBeenCalledWith("team-decisions", expect.objectContaining({ expectedVersion: 0, name: "团队决策", previewId: `mrpv1.${"a".repeat(64)}` }), "tenant-a"));
    await waitFor(() => expect(document.body.textContent).toContain("audit-1"));
  });

  it("知识资源范围通过 Assignment signed preview→commit 管理", async () => {
    mocks.listMemoryKnowledge.mockResolvedValue({ tenantId: "tenant-a", authority: "governance_assignment_sets", accessMode: "manage", suites: [], knowledge: [{ resourceId: "kb-1", name: "知识库", status: "enabled", policyEnabled: true, scope: [{ assigneeType: "everyone", effect: "allow" }], source: "governance", version: 2, updatedAt: "2026-08-14T00:00:00.000Z" }], memory: [], effective: { organizationKnowledge: true, organizationMemory: false } });
    mocks.listMemberships.mockResolvedValue({ memberships: [
      { userId: "user-1", status: "active", directoryProfile: { displayName: "成员一" } },
      { userId: "user-2", status: "active", directoryProfile: { displayName: "成员二" } },
    ] });
    mocks.previewAssignment.mockResolvedValue({ previewId: `apv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", impact: {}, changeId: "intent-2" });
    mocks.updateAssignment.mockResolvedValue({ changeId: "change-2", auditId: "audit-2" });
    render(<OrganizationMemoryKnowledgePage tenantId="tenant-a" />);
    fireEvent.click(await screen.findByText(/高级配置：逐个 Collection/));
    fireEvent.click(await screen.findByRole("button", { name: "管理安全范围" }));
    fireEvent.change(screen.getByLabelText("kb-1规则1主体类型"), { target: { value: "user" } });
    fireEvent.change(await screen.findByLabelText("kb-1规则1主体"), { target: { value: "user-1" } });
    fireEvent.click(screen.getAllByRole("button", { name: "新增 Assignment 规则" })[1]);
    fireEvent.change(screen.getByLabelText("kb-1规则2主体类型"), { target: { value: "user" } });
    fireEvent.change(await screen.findByLabelText("kb-1规则2主体"), { target: { value: "user-2" } });
    fireEvent.click(screen.getAllByRole("button", { name: "生成签名预览" })[1]);
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    await waitFor(() => expect(mocks.updateAssignment).toHaveBeenCalledWith("org_knowledge", "kb-1", expect.objectContaining({ expectedVersion: 2, assignments: [{ assigneeType: "user", assigneeId: "user-1", effect: "allow" }, { assigneeType: "user", assigneeId: "user-2", effect: "allow" }] }), "tenant-a"));
  });

  it("高级配置可无损提交目录群组与 Agent 的 allow/deny 规则", async () => {
    mocks.listMemoryKnowledge.mockResolvedValue({ tenantId: "tenant-a", authority: "governance_assignment_sets",
      accessMode: "manage", suites: [], knowledge: [{ resourceId: "kb-advanced", name: "复杂知识库",
        status: "enabled", policyEnabled: true, scope: [
          { assigneeType: "directory_group", assigneeId: "dept-rd", effect: "allow", origin: "migration" },
          { assigneeType: "agent", assigneeId: "agent-1", effect: "deny", origin: "direct" },
        ], source: "governance", version: 4, updatedAt: "2026-08-25T00:00:00.000Z" }], memory: [],
      effective: { organizationKnowledge: true, organizationMemory: false } });
    mocks.listDirectoryGroups.mockResolvedValue({ groups: [{ groupId: "dept-rd", displayName: "研发部", status: "active" }] });
    authFetchMock.mockResolvedValue(new Response(JSON.stringify([{ id: "agent-1", name: "研发 Agent", enabled: true }]),
      { status: 200, headers: { "Content-Type": "application/json" } }));
    mocks.previewAssignment.mockResolvedValue({ previewId: `apv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z", impact: {}, changeId: "intent-advanced" });
    render(<OrganizationMemoryKnowledgePage tenantId="tenant-a" />);
    fireEvent.click(await screen.findByText(/高级配置：逐个 Collection/));
    fireEvent.click(await screen.findByRole("button", { name: "管理安全范围" }));
    expect((await screen.findByLabelText("kb-advanced规则1主体") as HTMLSelectElement).value).toBe("dept-rd");
    expect((screen.getByLabelText("kb-advanced规则2主体") as HTMLSelectElement).value).toBe("agent-1");
    fireEvent.click(screen.getAllByRole("button", { name: "生成签名预览" })[1]);
    await waitFor(() => expect(mocks.previewAssignment).toHaveBeenCalledWith("org_knowledge", "kb-advanced",
      expect.objectContaining({ assignments: [
        { assigneeType: "directory_group", assigneeId: "dept-rd", effect: "allow" },
        { assigneeType: "agent", assigneeId: "agent-1", effect: "deny" },
      ] }), "tenant-a"));
  });

  it("Taskboard 缺少必需 Collection 时明确告警并禁止简单提交", async () => {
    const resources = ["taskboard-projects", "taskboard-tasks"].map(resourceId => ({
      resourceId, name: resourceId, version: 1, status: "enabled" as const,
    }));
    mocks.listMemoryKnowledge.mockResolvedValue({ tenantId: "tenant-a", authority: "governance_assignment_sets",
      accessMode: "manage", suites: [{ suiteId: "taskboard", name: "Taskboard 项目与任务", description: "套件",
        policyEnabled: true, resourceIds: resources.map(item => item.resourceId),
        expectedResourceIds: ["taskboard-projects", "taskboard-tasks", "taskboard-events"],
        missingResourceIds: ["taskboard-events"], unknownResourceIds: [], completeness: "incomplete", resources,
        configuration: { mode: "none", userIds: [], groupIds: [] } }],
      knowledge: [], memory: [], effective: { organizationKnowledge: true, organizationMemory: false } });
    render(<OrganizationMemoryKnowledgePage tenantId="tenant-a" />);
    expect(await screen.findByText(/缺少：taskboard-events/)).toBeTruthy();
    expect(screen.getByText(/套件定义不完整/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "预览完整差异" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("同步 snapshot 失败显示不可用而不是伪装成没有同步记录", async () => {
    const resources = ["taskboard-projects", "taskboard-tasks", "taskboard-events"].map(resourceId => ({
      resourceId, name: resourceId, version: 1, status: "enabled" as const,
    }));
    mocks.getSnapshot.mockRejectedValue(new Error("snapshot unavailable"));
    mocks.listMemoryKnowledge.mockResolvedValue({ tenantId: "tenant-a", authority: "governance_assignment_sets",
      accessMode: "manage", suites: [{ suiteId: "taskboard", name: "Taskboard", description: "套件",
        policyEnabled: true, resourceIds: resources.map(item => item.resourceId),
        expectedResourceIds: resources.map(item => item.resourceId), missingResourceIds: [], unknownResourceIds: [],
        completeness: "complete", resources, configuration: { mode: "none", userIds: [], groupIds: [] } }],
      knowledge: [], memory: [], effective: { organizationKnowledge: true, organizationMemory: false } });
    render(<OrganizationMemoryKnowledgePage tenantId="tenant-a" />);
    expect(await screen.findByText(/同步状态不可用：snapshot unavailable/)).toBeTruthy();
    expect(screen.queryByText("未发现同步记录")).toBeNull();
  });

  it("环境范围展示权威模板目录和 effective scope", async () => {
    mocks.getEntitlements.mockResolvedValue({ entitlement: null, policies: [], scopes: [{ resourceType: "environment_template", mode: "selected", resourceIds: ["env-python"], version: 2 }] });
    mocks.listEnvironmentTemplates.mockResolvedValue({ templates: [{ templateId: "env-python", name: "Python", status: "published", revision: 4 }, { templateId: "env-old", name: "Old", status: "retired", revision: 5 }] });
    mocks.listEntitlementResourceCatalog.mockResolvedValue({ resourceType: "environment_template", items: [{ resourceId: "env-python", label: "Python", version: 4 }] });
    render(<OrganizationEnvironmentsPage tenantId="tenant-a" />);
    expect(await screen.findByText("Python")).toBeTruthy();
    expect(screen.queryByText("Old")).toBeNull();
    expect(screen.getByText(/Entitlement 权威源.*v2/)).toBeTruthy();
  });

  it("凭据草稿注册统一 dirty guard", async () => {
    mocks.listCredentials.mockResolvedValue({ credentials: [] });
    mocks.listConnectors.mockResolvedValue({ connectors: [{ connectorId: "github", name: "GitHub", status: "published", version: 1, authMethods: ["token"], healthTestSupported: false }] });
    const credentialNavigation = renderWithDirtyNavigation(<OrganizationCredentialsPage tenantId="tenant-a" />);
    fireEvent.change(await screen.findByLabelText("连接器目录"), { target: { value: "github" } });
    fireEvent.click(screen.getByRole("button", { name: "切换组织页面" }));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(credentialNavigation).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "放弃更改" }));
    await waitFor(() => expect(credentialNavigation).toHaveBeenCalledTimes(1));
  });

  it("环境范围草稿注册统一 dirty guard", async () => {
    mocks.getEntitlements.mockResolvedValue({ entitlement: null, policies: [], scopes: [{ resourceType: "environment_template", mode: "selected", resourceIds: ["env-python"], version: 2 }] });
    mocks.listEnvironmentTemplates.mockResolvedValue({ templates: [
      { templateId: "env-python", name: "Python", status: "published", revision: 4 },
      { templateId: "env-node", name: "Node.js", status: "published", revision: 1 },
    ] });
    mocks.listEntitlementResourceCatalog.mockResolvedValue({ resourceType: "environment_template", items: [
      { resourceId: "env-python", label: "Python", version: 4 },
      { resourceId: "env-node", label: "Node.js", version: 1 },
    ] });
    const navigated = renderWithDirtyNavigation(<OrganizationEnvironmentsPage tenantId="tenant-a" />);
    const nodeCheckbox = (await screen.findByText("Node.js")).closest("label")?.querySelector("input");
    expect(nodeCheckbox).toBeTruthy();
    fireEvent.click(nodeCheckbox!);
    fireEvent.click(screen.getByRole("button", { name: "切换组织页面" }));
    expect(await screen.findByText("有未保存的更改")).toBeTruthy();
    expect(navigated).not.toHaveBeenCalled();
  });
});
