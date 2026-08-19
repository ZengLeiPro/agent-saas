import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { governanceRoute } from "@/lib/governanceNavigation";
import { DEFAULT_TENANT_SETTINGS } from "@/components/TenantManager/types";
import { PlatformOrganizationGovernance } from "./PlatformGovernancePage";

const mocks = vi.hoisted(() => ({
  getEntitlements: vi.fn(), listResourceCatalog: vi.fn(), previewScope: vi.fn(), updateScope: vi.fn(),
  getTenantLifecycle: vi.fn(), previewTenantLifecycle: vi.fn(), updateTenantLifecycle: vi.fn(),
  getTenantSettings: vi.fn(), updateTenantSettings: vi.fn(), updateTenantFeatures: vi.fn(),
}));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: null, updateTenantFeatures: mocks.updateTenantFeatures }),
}));
vi.mock("@agent/shared/lib/governanceApi", () => ({
  governanceAccessApi: {
    getEntitlements: mocks.getEntitlements,
    previewEntitlementScope: mocks.previewScope,
    updateEntitlementScope: mocks.updateScope,
    getTenantLifecycle: mocks.getTenantLifecycle,
    previewTenantLifecycle: mocks.previewTenantLifecycle,
    updateTenantLifecycle: mocks.updateTenantLifecycle,
    getTenantSettings: mocks.getTenantSettings,
    updateTenantSettings: mocks.updateTenantSettings,
  },
  governanceResourcesApi: { listEntitlementResourceCatalog: mocks.listResourceCatalog },
}));

const response = {
  entitlement: { tenantId: "tenant-a", source: "platform_override", status: "active", limits: { seats: 30 }, version: 5 },
  scopes: [{ resourceType: "connector", mode: "selected", resourceIds: ["github"], source: "governance", version: 2, allowedActions: [{ id: "edit_scope", label: "从目录编辑" }] }],
  policies: [{ policyKey: "connector.personal_oauth.allowed", value: true, source: "governance", version: 1 }],
};

describe("PlatformOrganizationGovernance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEntitlements.mockResolvedValue(response);
    mocks.listResourceCatalog.mockResolvedValue({ resourceType: "connector", items: [{ resourceId: "github", label: "GitHub", version: 3 }] });
    mocks.previewScope.mockResolvedValue({
      previewId: `gpv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64), expiresAt: "2099-08-10T10:05:00.000Z",
      impact: { currentVersion: 2, nextVersion: 9, from: { mode: "selected", resourceCount: 1 }, to: { mode: "all", resourceCount: 4 }, blockers: [], reversible: true, effectiveMode: "source_immediate_projection_pending" },
    });
    mocks.updateScope.mockResolvedValue({ changeId: "change-scope-1", auditId: "audit-scope-1", effectiveAt: "2026-08-10T10:00:01.000Z", projectionStatus: "pending", projectionId: "projection-scope-1" });
    mocks.getTenantLifecycle.mockResolvedValue({
      tenantId: "tenant-a",
      tenantName: "测试组织",
      status: "active",
      updatedAt: "2026-08-10T10:00:00.000Z",
      allowedActions: [{ id: "suspend", label: "暂停组织", action: "suspend", requiresReason: true }],
    });
    mocks.previewTenantLifecycle.mockResolvedValue({
      previewId: `tlpv1.${"c".repeat(64)}`,
      baselineDigest: "d".repeat(64),
      expiresAt: "2099-08-10T10:05:00.000Z",
      impact: { tenantId: "tenant-a", from: "active", to: "suspended", affectedResources: [{ type: "membership", id: "user-1", version: 2 }], blockers: [], reversible: true, effectiveMode: "immediate" },
    });
    mocks.updateTenantLifecycle.mockResolvedValue({
      tenantId: "tenant-a",
      tenantName: "测试组织",
      status: "suspended",
      updatedAt: "2026-08-10T10:00:01.000Z",
      changeId: "change-lifecycle-1",
      auditId: "audit-lifecycle-1",
      effectiveAt: "2026-08-10T10:00:01.000Z",
    });
    mocks.getTenantSettings.mockResolvedValue({
      tenantId: "tenant-a",
      settings: { ...structuredClone(DEFAULT_TENANT_SETTINGS), features: { ...structuredClone(DEFAULT_TENANT_SETTINGS.features), debugModeAllowed: false, debugModeEnabled: false } },
      updatedAt: "2026-08-10T10:00:00.000Z",
    });
    mocks.updateTenantSettings.mockResolvedValue({
      tenantId: "tenant-a",
      settings: { ...structuredClone(DEFAULT_TENANT_SETTINGS), features: { ...structuredClone(DEFAULT_TENANT_SETTINGS.features), debugModeAllowed: true, debugModeEnabled: false } },
      updatedAt: "2026-08-10T10:01:00.000Z",
    });
  });

  it("目标组织配置提供平台调试模式授权", async () => {
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "configuration" })} />);
    fireEvent.click(await screen.findByRole("switch", { name: "调试模式授权" }));
    await waitFor(() => expect(mocks.updateTenantSettings).toHaveBeenCalledWith("tenant-a", expect.objectContaining({
      expectedUpdatedAt: "2026-08-10T10:00:00.000Z",
      settings: expect.objectContaining({ features: expect.objectContaining({ debugModeAllowed: true }) }),
    })));
  });

  it("权益页展示权威来源、版本与硬上限，但不开放无预览写入", async () => {
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "entitlements" })} />);
    expect(await screen.findByText("平台单独配置")).toBeTruthy();
    expect(screen.queryByText("platform_override")).toBeNull();
    expect(screen.getByText("30")).toBeTruthy();
    expect(screen.getByText(/后端未返回可执行动作/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /保存|提交/ })).not.toBeTruthy();
  });

  it("资源范围只能从后端权威目录选择，禁止手填 ID", async () => {
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "resource-scope" })} />);
    expect(await screen.findByText("已选 1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "从目录编辑" }));
    expect(await screen.findByText("GitHub")).toBeTruthy();
    expect(screen.getByRole("checkbox")).toBeTruthy();
    expect(screen.queryByRole("textbox")).not.toBeTruthy();
  });

  it("Scope 使用后端 impact 版本并在提交后留屏展示治理回执", async () => {
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "resource-scope" })} />);
    fireEvent.click(await screen.findByRole("button", { name: "从目录编辑" }));
    fireEvent.click(await screen.findByRole("button", { name: "全部允许" }));
    fireEvent.click(screen.getByRole("button", { name: "预览变更" }));
    expect(await screen.findByText(/v2 → v9/)).toBeTruthy();
    expect(screen.queryByText(/v2 → v3/)).not.toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认提交" }));
    await waitFor(() => expect(mocks.updateScope).toHaveBeenCalled());
    expect(await screen.findByText("changeId：change-scope-1")).toBeTruthy();
    expect(screen.getByText("auditId：audit-scope-1")).toBeTruthy();
    expect(screen.getByText(/投影：等待中/)).toBeTruthy();
    expect(screen.queryByText(/投影：pending/)).toBeNull();
  });

  it("目录已移除的历史选项标为失效并阻断预览", async () => {
    mocks.getEntitlements.mockResolvedValue({
      ...response,
      scopes: [{ ...response.scopes[0], resourceIds: ["retired-connector"] }],
    });
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "resource-scope" })} />);
    fireEvent.click(await screen.findByRole("button", { name: "从目录编辑" }));
    expect(await screen.findByText(/当前范围含已退出目录的资源：/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "预览变更" }).hasAttribute("disabled")).toBe(true);
  });

  it.each([
    ["trial", "试用中", "plan_default", "套餐默认"],
    ["expired", "已过期", "legacy_migrated", "历史迁移"],
  ])("合法权益状态 %s 与来源 %s 使用中文展示", async (status, statusLabel, source, sourceLabel) => {
    mocks.getEntitlements.mockResolvedValue({
      ...response,
      entitlement: { ...response.entitlement, status, source },
    });
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "overview" })} />);
    expect(await screen.findByText(statusLabel)).toBeTruthy();
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "entitlements" })} />);
    expect(await screen.findByText(sourceLabel)).toBeTruthy();
  });

  it("组织暂停经过原因、影响预览和二次确认后提交，并刷新权威状态", async () => {
    mocks.getTenantLifecycle
      .mockResolvedValueOnce({
        tenantId: "tenant-a",
        tenantName: "测试组织",
        status: "active",
        updatedAt: "2026-08-10T10:00:00.000Z",
        allowedActions: [{ id: "suspend", label: "暂停组织", action: "suspend", requiresReason: true }],
      })
      .mockResolvedValue({
        tenantId: "tenant-a",
        tenantName: "测试组织",
        status: "suspended",
        updatedAt: "2026-08-10T10:00:01.000Z",
        allowedActions: [{ id: "resume", label: "恢复组织", action: "resume", requiresReason: true }],
      });
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "security-lifecycle" })} />);

    fireEvent.change(await screen.findByPlaceholderText("填写操作原因"), { target: { value: "测试组织暂停验收" } });
    fireEvent.click(screen.getByRole("button", { name: "暂停组织" }));

    expect(await screen.findByText(/启用 → 已暂停 · 可逆/)).toBeTruthy();
    expect(screen.getByText("确认暂停组织：测试组织")).toBeTruthy();
    expect(screen.getByText(/成员后续登录和新执行请求将被拒绝/)).toBeTruthy();
    expect(screen.getByText(/user-1/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "确认暂停组织" }));
    await waitFor(() => expect(mocks.updateTenantLifecycle).toHaveBeenCalledWith("tenant-a", expect.objectContaining({
      action: "suspend",
      reason: "测试组织暂停验收",
      previewId: `tlpv1.${"c".repeat(64)}`,
      baselineDigest: "d".repeat(64),
    })));
    expect(await screen.findByText("changeId：change-lifecycle-1")).toBeTruthy();
    expect(screen.getByText("auditId：audit-lifecycle-1")).toBeTruthy();
    await waitFor(() => expect(mocks.getTenantLifecycle).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("已暂停")).toBeTruthy();
  });

  it("跨实例传播待重试时显示警告回执，不宣称立即生效", async () => {
    mocks.updateTenantLifecycle.mockResolvedValueOnce({
      changeId: "change-lifecycle-pending",
      auditId: "audit-lifecycle-pending",
      effectiveAt: "2026-08-10T10:00:01.000Z",
      propagationStatus: "pending",
      warning: "Tenant state persisted; cross-instance effects are retrying",
      code: "TENANT_LIFECYCLE_PROPAGATION_PENDING",
    });
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "security-lifecycle" })} />);

    fireEvent.change(await screen.findByPlaceholderText("填写操作原因"), { target: { value: "传播降级提示测试" } });
    fireEvent.click(screen.getByRole("button", { name: "暂停组织" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认暂停组织" }));

    expect(await screen.findByText("组织状态已保存，跨实例生效正在重试")).toBeTruthy();
    expect(screen.queryByText("变更回执")).toBeNull();
    expect(screen.getByText("Tenant state persisted; cross-instance effects are retrying")).toBeTruthy();
  });

  it("生命周期请求进行中禁用操作按钮，快速重复点击只发送一次预览", async () => {
    let resolvePreview!: (value: unknown) => void;
    mocks.previewTenantLifecycle.mockImplementationOnce(() => new Promise(resolve => { resolvePreview = resolve; }));
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "security-lifecycle" })} />);

    const reasonInput = await screen.findByPlaceholderText("填写操作原因");
    fireEvent.change(reasonInput, { target: { value: "重复点击防护测试" } });
    const action = screen.getByRole("button", { name: "暂停组织" });
    fireEvent.click(action);
    fireEvent.click(action);

    expect(mocks.previewTenantLifecycle).toHaveBeenCalledTimes(1);
    expect(action.hasAttribute("disabled")).toBe(true);
    expect(reasonInput.hasAttribute("disabled")).toBe(true);
    await act(async () => {
      resolvePreview({
        previewId: `tlpv1.${"c".repeat(64)}`,
        baselineDigest: "d".repeat(64),
        expiresAt: "2099-08-10T10:05:00.000Z",
        impact: { tenantId: "tenant-a", from: "active", to: "suspended", affectedResources: [{ type: "membership", id: "user-1", version: 2 }], blockers: [], reversible: true, effectiveMode: "immediate" },
      });
    });
    expect(await screen.findByRole("button", { name: "确认暂停组织" })).toBeTruthy();
  });

  it("生命周期提交同步防重，快速重复确认只发送一次请求", async () => {
    let resolveCommit!: (value: unknown) => void;
    mocks.updateTenantLifecycle.mockImplementationOnce(() => new Promise(resolve => { resolveCommit = resolve; }));
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "security-lifecycle" })} />);

    fireEvent.change(await screen.findByPlaceholderText("填写操作原因"), { target: { value: "重复提交防护测试" } });
    fireEvent.click(screen.getByRole("button", { name: "暂停组织" }));
    const confirm = await screen.findByRole("button", { name: "确认暂停组织" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(mocks.updateTenantLifecycle).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCommit({ changeId: "change-lifecycle-1", auditId: "audit-lifecycle-1", effectiveAt: "2026-08-10T10:00:01.000Z" });
    });
  });

  it("切换组织时清除上一组织回执", async () => {
    const view = render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "security-lifecycle" })} />);

    fireEvent.change(await screen.findByPlaceholderText("填写操作原因"), { target: { value: "组织切换回执测试" } });
    fireEvent.click(screen.getByRole("button", { name: "暂停组织" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认暂停组织" }));
    expect(await screen.findByText("changeId：change-lifecycle-1")).toBeTruthy();

    mocks.getTenantLifecycle.mockResolvedValue({
      tenantId: "tenant-b",
      tenantName: "组织 B",
      status: "active",
      updatedAt: "2026-08-10T10:02:00.000Z",
      allowedActions: [{ id: "suspend", label: "暂停组织", action: "suspend", requiresReason: true }],
    });
    view.rerender(<PlatformOrganizationGovernance tenantId="tenant-b" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-b", tab: "security-lifecycle" })} />);

    expect(await screen.findByText("组织 B")).toBeTruthy();
    expect(screen.queryByText("changeId：change-lifecycle-1")).toBeNull();
  });

  it("生命周期变更成功后刷新失败仍保留成功回执", async () => {
    mocks.getTenantLifecycle
      .mockResolvedValueOnce({
        tenantId: "tenant-a",
        tenantName: "测试组织",
        status: "active",
        updatedAt: "2026-08-10T10:00:00.000Z",
        allowedActions: [{ id: "suspend", label: "暂停组织", action: "suspend", requiresReason: true }],
      })
      .mockRejectedValueOnce(new Error("refresh unavailable"));
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "security-lifecycle" })} />);

    fireEvent.change(await screen.findByPlaceholderText("填写操作原因"), { target: { value: "刷新失败回执测试" } });
    fireEvent.click(screen.getByRole("button", { name: "暂停组织" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认暂停组织" }));

    expect(await screen.findByText("changeId：change-lifecycle-1")).toBeTruthy();
    expect(await screen.findByText(/变更已生效，但组织状态刷新失败：refresh unavailable/)).toBeTruthy();
  });

  it("生命周期提交冲突清除旧预览、刷新权威状态且不制造成功回执", async () => {
    mocks.updateTenantLifecycle.mockRejectedValueOnce(new Error("Tenant lifecycle baseline changed"));
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "security-lifecycle" })} />);

    fireEvent.change(await screen.findByPlaceholderText("填写操作原因"), { target: { value: "并发冲突测试" } });
    fireEvent.click(screen.getByRole("button", { name: "暂停组织" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认暂停组织" }));

    expect(await screen.findByText("Tenant lifecycle baseline changed")).toBeTruthy();
    expect(screen.queryByText("变更回执")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认暂停组织" })).toBeNull();
    await waitFor(() => expect(mocks.getTenantLifecycle).toHaveBeenCalledTimes(2));
  });

  it("API 失败不回退旧 TenantSettings", async () => {
    mocks.getEntitlements.mockRejectedValue(new Error("unavailable"));
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "overview" })} />);
    expect(await screen.findByText("权限服务暂不可用")).toBeTruthy();
  });
});
