import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const retry = vi.fn();
const governanceError = Object.assign(new Error("private backend detail"), { status: 503 });
const governanceApi = vi.hoisted(() => ({ listOAuthGrants: vi.fn(), previewOAuthGrantRevocation: vi.fn(), revokeOAuthGrant: vi.fn() }));
const authApi = vi.hoisted(() => ({ authFetch: vi.fn() }));
const authState = vi.hoisted(() => ({
  user: null as { tenantId: string; debugMode?: boolean; tenantFeatures?: { debugModeAllowed: boolean; debugModeEnabled?: boolean } } | null,
  updateDebugMode: vi.fn(),
}));
const sharedApi = vi.hoisted(() => ({
  startGoogleWorkspaceOAuth: vi.fn(),
  isDebugModeAvailable: vi.fn((tenantId: string, features?: { debugModeAllowed: boolean; debugModeEnabled?: boolean }) => (
    tenantId === "pantheon" || (features?.debugModeAllowed === true && features.debugModeEnabled === true)
  )),
}));

vi.mock("@/hooks/useEffectiveResources", () => ({
  useEffectiveResources: () => ({ data: null, loading: false, error: governanceError, retry }),
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => authState,
}));
vi.mock("@/lib/authFetch", () => ({ authFetch: authApi.authFetch }));
vi.mock("@agent/shared/lib/governanceApi", () => ({ governanceAccessApi: governanceApi }));
vi.mock("@agent/shared", () => sharedApi);

import { ConnectionsSection, MyPermissionsSection } from "./V2Sections";

describe("我的权限 fail-closed", () => {
  beforeEach(() => {
    authState.user = null;
    authState.updateDebugMode.mockReset();
    authApi.authFetch.mockReset();
  });

  it("503 时复用权威资源列表的不可用态，不泄露后端详情或本地推导允许", () => {
    render(<MyPermissionsSection />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("不会降级为允许");
    expect(alert.textContent).toContain("服务状态：503");
    expect(alert.textContent).not.toContain("private backend detail");
  });

  it("个人开关使用三级有效值，保存后更新认证态", async () => {
    authState.user = {
      tenantId: "tenant-a",
      debugMode: false,
      tenantFeatures: { debugModeAllowed: true, debugModeEnabled: true },
    };
    authApi.authFetch.mockResolvedValue(new Response(JSON.stringify({ debugMode: true }), { status: 200 }));
    render(<MyPermissionsSection />);
    const toggle = screen.getByRole("switch", { name: "个人调试模式" });
    expect((toggle as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(authState.updateDebugMode).toHaveBeenCalledWith(true));
    expect(authApi.authFetch).toHaveBeenCalledWith("/api/auth/me/debug-mode", expect.objectContaining({ method: "PATCH" }));
  });

  it("上级任一开关关闭时个人开关禁用", () => {
    authState.user = {
      tenantId: "tenant-a",
      debugMode: true,
      tenantFeatures: { debugModeAllowed: true, debugModeEnabled: false },
    };
    render(<MyPermissionsSection />);
    expect((screen.getByRole("switch", { name: "个人调试模式" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("组织尚未开放，当前不能开启个人调试模式。")).toBeTruthy();
  });
});

describe("连接与授权", () => {
  beforeEach(() => {
    governanceApi.listOAuthGrants.mockReset();
    governanceApi.previewOAuthGrantRevocation.mockReset();
    governanceApi.revokeOAuthGrant.mockReset();
    sharedApi.startGoogleWorkspaceOAuth.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("外部授权前展示服务端 scope 与用途并要求二次确认", async () => {
    governanceApi.listOAuthGrants.mockResolvedValue({ grants: [] });
    sharedApi.startGoogleWorkspaceOAuth.mockResolvedValue({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=signed",
      state: "signed", requestedScopes: ["drive.readonly", "calendar.readonly"],
      purpose: "供获指派的 Agent Run 读取工作资料", riskLevel: "high",
      dataDestination: "Google Workspace API", revokeMethod: "连接与授权页撤销",
    });
    const popup = { location: { href: "" }, closed: false, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    render(<ConnectionsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "连接" }));
    expect(await screen.findByText("drive.readonly")).toBeTruthy();
    expect(screen.getByText("供获指派的 Agent Run 读取工作资料")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "前往 Google 授权" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toContain("accounts.google.com");
  });

  it("活动 OAuth Grant 通过签名预览后才允许撤销，并保留可见治理回执", async () => {
    governanceApi.listOAuthGrants.mockResolvedValue({ grants: [{
      grantId: "grant-1", tenantId: "tenant-a", subjectUserId: "user-1", provider: "google", connectorId: "google-workspace",
      status: "active", scopeSummary: [], approvedAt: "2026-08-10T00:00:00.000Z", version: 1, approvals: [],
    }] });
    governanceApi.previewOAuthGrantRevocation.mockResolvedValue({
      previewId: `ogpv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64), expiresAt: "2099-08-10T01:00:00.000Z",
      impact: { provider: "google", connectorId: "google-workspace", action: "revoke", immediatelyUnavailable: true, newRuns: "blocked", reversible: false, effectiveMode: "immediate", affectedAgents: [], affectedAutomations: [], brokenReferences: [], blockers: [], warnings: [], currentVersion: 1, nextVersion: 2 },
    });
    governanceApi.revokeOAuthGrant.mockResolvedValue({
      grantId: "grant-1", status: "revoked", version: 2,
      changeId: "commit-intent", auditId: "commit-terminal",
    });
    render(<ConnectionsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "撤销授权" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认撤销" }));
    await waitFor(() => expect(governanceApi.revokeOAuthGrant).toHaveBeenCalledWith("grant-1", expect.objectContaining({
      previewId: `ogpv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64),
    })));
    const receipt = await screen.findByRole("status");
    expect(receipt.textContent).toContain("状态：revoked");
    expect(receipt.textContent).toContain("Change ID：commit-intent");
    expect(receipt.textContent).toContain("Audit ID：commit-terminal");
  });

  it("撤销失败时不展示成功回执", async () => {
    governanceApi.listOAuthGrants.mockResolvedValue({ grants: [{
      grantId: "grant-1", tenantId: "tenant-a", subjectUserId: "user-1", provider: "google", connectorId: "google-workspace",
      status: "active", scopeSummary: [], approvedAt: "2026-08-10T00:00:00.000Z", version: 1, approvals: [],
    }] });
    governanceApi.previewOAuthGrantRevocation.mockResolvedValue({
      previewId: `ogpv1.${"a".repeat(64)}`, baselineDigest: "b".repeat(64), expiresAt: "2099-08-10T01:00:00.000Z",
      impact: { provider: "google", connectorId: "google-workspace", action: "revoke", immediatelyUnavailable: true, newRuns: "blocked", reversible: false, effectiveMode: "immediate", affectedAgents: [], affectedAutomations: [], brokenReferences: [], blockers: [], warnings: [], currentVersion: 1, nextVersion: 2 },
    });
    governanceApi.revokeOAuthGrant.mockRejectedValue(new Error("撤销执行失败"));
    render(<ConnectionsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "撤销授权" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认撤销" }));
    expect(await screen.findByText("撤销执行失败")).toBeTruthy();
    expect(screen.queryByText("OAuth 授权撤销回执")).toBeNull();
  });
});
