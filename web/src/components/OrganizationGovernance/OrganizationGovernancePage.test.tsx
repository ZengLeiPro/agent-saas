import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { governanceRoute } from "@/lib/governanceNavigation";
import { OrganizationCredentialsPage, OrganizationEnvironmentsPage, OrganizationGroupsPage, OrganizationMemoryKnowledgePage, OrganizationMembersPage, OrganizationOffboardingPage, OrganizationPoliciesPage } from "./OrganizationGovernancePage";

const mocks = vi.hoisted(() => ({
  listMemberships: vi.fn(), createMembership: vi.fn(), getMembershipDetails: vi.fn(), listDirectoryGroups: vi.fn(), listCredentials: vi.fn(), listConnectors: vi.fn(), getEntitlements: vi.fn(), listMemoryKnowledge: vi.fn(), listEnvironmentTemplates: vi.fn(),
  previewMembership: vi.fn(), updateMembership: vi.fn(), previewUserOffboarding: vi.fn(), startUserOffboarding: vi.fn(), previewPolicy: vi.fn(), updatePolicy: vi.fn(), previewMemoryResource: vi.fn(), updateMemoryResource: vi.fn(), previewAssignment: vi.fn(), updateAssignment: vi.fn(),
  previewEntitlementScope: vi.fn(), updateEntitlementScope: vi.fn(), previewCredentialCreate: vi.fn(), createCredential: vi.fn(), previewCredentialRotation: vi.fn(), rotateCredential: vi.fn(), previewCredentialTransfer: vi.fn(), transferCredential: vi.fn(), testCredentialHealth: vi.fn(),
}));

const authState = vi.hoisted(() => ({ isAdmin: true, username: "org-admin" }));

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

vi.mock("@/components/TenantManager/hooks", () => ({
  useTenants: () => ({ tenants: [], loading: false }),
}));

vi.mock("@agent/shared/lib/governanceApi", () => ({
  governanceAccessApi: {
    listMemberships: mocks.listMemberships,
    createMembership: mocks.createMembership,
    getMembershipDetails: mocks.getMembershipDetails,
    listDirectoryGroups: mocks.listDirectoryGroups,
    previewMembership: mocks.previewMembership,
    updateMembership: mocks.updateMembership,
    getEntitlements: mocks.getEntitlements,
    listMemoryKnowledge: mocks.listMemoryKnowledge,
    previewMemoryResource: mocks.previewMemoryResource,
    updateMemoryResource: mocks.updateMemoryResource,
    previewAssignment: mocks.previewAssignment,
    updateAssignment: mocks.updateAssignment,
    previewPolicy: mocks.previewPolicy,
    updatePolicy: mocks.updatePolicy,
    previewEntitlementScope: mocks.previewEntitlementScope,
    updateEntitlementScope: mocks.updateEntitlementScope,
  },
  governanceResourcesApi: {
    listCredentials: mocks.listCredentials,
    listConnectors: mocks.listConnectors,
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

describe("OrganizationGovernancePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.isAdmin = true;
    authState.username = "org-admin";
    mocks.listConnectors.mockResolvedValue({ connectors: [] });
    mocks.listMemberships.mockResolvedValue({ memberships: [] });
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

  it("组织策略明确显示继承状态并执行 preview→commit", async () => {
    mocks.getEntitlements.mockResolvedValue({ entitlement: { source: "plan_default", status: "active", limits: {}, version: 1 }, scopes: [], policies: [{ policyKey: "knowledge.org.enabled", value: true, source: "legacy_projection", version: 3 }] });
    mocks.previewPolicy.mockResolvedValue({ previewId: `gpv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", impact: {}, changeId: "intent-1" });
    mocks.updatePolicy.mockResolvedValue({ changeId: "change-1", auditId: "audit-1", effectiveAt: "2026-08-14T00:00:00.000Z" });
    render(<OrganizationPoliciesPage tenantId="tenant-a" />);
    expect(await screen.findByText(/v3 · 继承（当前允许）/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("knowledge.org.enabled 策略"), { target: { value: "deny" } });
    fireEvent.change(screen.getByLabelText("knowledge.org.enabled 变更原因"), { target: { value: "安全收敛" } });
    fireEvent.click(screen.getByRole("button", { name: "预览" }));
    fireEvent.click(await screen.findByRole("button", { name: "提交" }));
    await waitFor(() => expect(mocks.updatePolicy).toHaveBeenCalledWith("knowledge.org.enabled", expect.objectContaining({ expectedVersion: 3, value: false, previewId: `gpv1.${"a".repeat(64)}` }), "tenant-a"));
  });

  it("记忆知识页使用组织权威元数据并可 signed preview→commit 创建 memory", async () => {
    mocks.listMemoryKnowledge.mockResolvedValue({ tenantId: "tenant-a", authority: "governance_assignment_sets", accessMode: "manage", knowledge: [], memory: [], effective: { organizationKnowledge: false, organizationMemory: false } });
    mocks.previewMemoryResource.mockResolvedValue({ previewId: `mrpv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", impact: { operation: "create" }, changeId: "intent-1" });
    mocks.updateMemoryResource.mockResolvedValue({ changeId: "change-1", auditId: "audit-1", effectiveAt: "2026-08-14T00:00:00.000Z", version: 1 });
    render(<OrganizationMemoryKnowledgePage tenantId="tenant-a" />);
    expect(await screen.findByText("当前组织没有组织知识资源。")).toBeTruthy();
    expect(screen.getByText("当前组织没有组织记忆资源。")).toBeTruthy();
    expect(screen.queryByText(/个人记忆资源/)).toBeNull();
    fireEvent.change(screen.getByLabelText("记忆资源 ID"), { target: { value: "team-decisions" } });
    fireEvent.change(screen.getByLabelText("team-decisions记忆名称"), { target: { value: "团队决策" } });
    fireEvent.change(screen.getByLabelText("team-decisions记忆变更原因"), { target: { value: "建立组织记忆" } });
    fireEvent.click(screen.getByRole("button", { name: "生成签名预览" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    await waitFor(() => expect(mocks.updateMemoryResource).toHaveBeenCalledWith("team-decisions", expect.objectContaining({ expectedVersion: 0, name: "团队决策", previewId: `mrpv1.${"a".repeat(64)}` }), "tenant-a"));
    await waitFor(() => expect(document.body.textContent).toContain("audit-1"));
  });

  it("知识资源范围通过 Assignment signed preview→commit 管理", async () => {
    mocks.listMemoryKnowledge.mockResolvedValue({ tenantId: "tenant-a", authority: "governance_assignment_sets", accessMode: "manage", knowledge: [{ resourceId: "kb-1", name: "知识库", status: "enabled", policyEnabled: true, scope: [{ assigneeType: "everyone", effect: "allow" }], source: "governance", version: 2, updatedAt: "2026-08-14T00:00:00.000Z" }], memory: [], effective: { organizationKnowledge: true, organizationMemory: false } });
    mocks.previewAssignment.mockResolvedValue({ previewId: `apv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z", impact: {}, changeId: "intent-2" });
    mocks.updateAssignment.mockResolvedValue({ changeId: "change-2", auditId: "audit-2" });
    render(<OrganizationMemoryKnowledgePage tenantId="tenant-a" />);
    fireEvent.click(await screen.findByRole("button", { name: "管理安全范围" }));
    fireEvent.change(screen.getByLabelText("kb-1成员范围"), { target: { value: "selected" } });
    fireEvent.change(screen.getByLabelText("kb-1成员 ID"), { target: { value: "user-1, user-2" } });
    fireEvent.click(screen.getAllByRole("button", { name: "生成签名预览" })[1]);
    fireEvent.click(await screen.findByRole("button", { name: "确认提交" }));
    await waitFor(() => expect(mocks.updateAssignment).toHaveBeenCalledWith("org_knowledge", "kb-1", expect.objectContaining({ expectedVersion: 2, assignments: [{ assigneeType: "user", assigneeId: "user-1", effect: "allow" }, { assigneeType: "user", assigneeId: "user-2", effect: "allow" }] }), "tenant-a"));
  });

  it("环境范围展示权威模板目录和 effective scope", async () => {
    mocks.getEntitlements.mockResolvedValue({ entitlement: null, policies: [], scopes: [{ resourceType: "environment_template", mode: "selected", resourceIds: ["env-python"], version: 2 }] });
    mocks.listEnvironmentTemplates.mockResolvedValue({ templates: [{ templateId: "env-python", name: "Python", status: "published", revision: 4 }, { templateId: "env-old", name: "Old", status: "retired", revision: 5 }] });
    render(<OrganizationEnvironmentsPage tenantId="tenant-a" />);
    expect(await screen.findByText("Python")).toBeTruthy();
    expect(screen.queryByText("Old")).toBeNull();
    expect(screen.getByText("v2")).toBeTruthy();
  });
});
