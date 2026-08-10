import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { governanceRoute } from "@/lib/governanceNavigation";
import { PlatformOrganizationGovernance } from "./PlatformGovernancePage";

const mocks = vi.hoisted(() => ({ getEntitlements: vi.fn() }));
vi.mock("@agent/shared/lib/governanceApi", () => ({ governanceAccessApi: { getEntitlements: mocks.getEntitlements } }));

const response = {
  entitlement: { tenantId: "tenant-a", source: "platform_override", status: "active", limits: { seats: 30 }, version: 5 },
  scopes: [{ resourceType: "connector", mode: "selected", resourceIds: ["github"], source: "governance", version: 2 }],
  policies: [{ policyKey: "connector.personal_oauth.allowed", value: true, source: "governance", version: 1 }],
};

describe("PlatformOrganizationGovernance", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getEntitlements.mockResolvedValue(response); });

  it("权益页展示权威来源、版本与硬上限，但不开放无预览写入", async () => {
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "entitlements" })} />);
    expect(await screen.findByText("platform_override")).toBeTruthy();
    expect(screen.getByText("30")).toBeTruthy();
    expect(screen.getByText(/暂不开放高影响写入/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /保存|提交/ })).not.toBeTruthy();
  });

  it("资源范围只展示目录选择结果", async () => {
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "resource-scope" })} />);
    expect(await screen.findByText("已选 1")).toBeTruthy();
    expect(screen.getByText("github")).toBeTruthy();
    expect(screen.queryByRole("textbox")).not.toBeTruthy();
  });

  it("API 失败不回退旧 TenantSettings", async () => {
    mocks.getEntitlements.mockRejectedValue(new Error("unavailable"));
    render(<PlatformOrganizationGovernance tenantId="tenant-a" route={governanceRoute("platform.org-business.tenants", { entityId: "tenant-a", tab: "overview" })} />);
    expect(await screen.findByText("权威治理结论暂不可获得")).toBeTruthy();
  });
});
