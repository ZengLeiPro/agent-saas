import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { governanceRoute } from "@/lib/governanceNavigation";
import { PlatformOrganizationGovernance } from "./PlatformGovernancePage";

const mocks = vi.hoisted(() => ({
  getEntitlements: vi.fn(), listResourceCatalog: vi.fn(), previewScope: vi.fn(), updateScope: vi.fn(),
}));
vi.mock("@agent/shared/lib/governanceApi", () => ({
  governanceAccessApi: {
    getEntitlements: mocks.getEntitlements,
    previewEntitlementScope: mocks.previewScope,
    updateEntitlementScope: mocks.updateScope,
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

  it("API 失败不回退旧 TenantSettings", async () => {
    mocks.getEntitlements.mockRejectedValue(new Error("unavailable"));
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "overview" })} />);
    expect(await screen.findByText("权威治理结论暂不可获得")).toBeTruthy();
  });
});
