// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  disconnectGoogleWorkspace: vi.fn(),
  fetchGoogleWorkspaceConnection: vi.fn(),
  setNativeConnectorRuntimeEnabled: vi.fn(),
  startGoogleWorkspaceOAuth: vi.fn(),
}));
const governanceMocks = vi.hoisted(() => ({
  listOAuthGrants: vi.fn(),
  previewOAuthGrantRevocation: vi.fn(),
  revokeOAuthGrant: vi.fn(),
}));

vi.mock("@agent/shared", () => sharedMocks);
vi.mock("@agent/shared/lib/governanceApi", () => ({ governanceAccessApi: governanceMocks }));

import { GoogleWorkspaceConnectorDrawer, useGoogleWorkspaceConnector } from "./GoogleWorkspaceConnector";

const grant = {
  grantId: "grant-google",
  tenantId: "tenant-a",
  subjectUserId: "user-1",
  provider: "google",
  connectorId: "google-workspace",
  status: "active",
  scopeSummary: ["drive.readonly"],
  approvedAt: "2026-09-09T00:00:00.000Z",
  version: 1,
  approvals: [],
};
const preview = {
  previewId: `ogpv1.${"a".repeat(64)}`,
  baselineDigest: "b".repeat(64),
  expiresAt: "2099-09-09T00:00:00.000Z",
  impact: {
    provider: "google",
    connectorId: "google-workspace",
    action: "revoke",
    immediatelyUnavailable: true,
    newRuns: "blocked",
    reversible: false,
    effectiveMode: "immediate",
    affectedAgents: [],
    affectedAutomations: [],
    brokenReferences: [],
    blockers: [],
    warnings: [],
    currentVersion: 1,
    nextVersion: 2,
  },
};

beforeEach(() => {
  sharedMocks.fetchGoogleWorkspaceConnection.mockReset();
  sharedMocks.disconnectGoogleWorkspace.mockReset();
  sharedMocks.setNativeConnectorRuntimeEnabled.mockReset();
  sharedMocks.startGoogleWorkspaceOAuth.mockReset();
  governanceMocks.listOAuthGrants.mockReset();
  governanceMocks.previewOAuthGrantRevocation.mockReset();
  governanceMocks.revokeOAuthGrant.mockReset();
  sharedMocks.fetchGoogleWorkspaceConnection.mockResolvedValue({ connection: null, available: true });
  governanceMocks.listOAuthGrants.mockResolvedValue({ grants: [] });
  sharedMocks.startGoogleWorkspaceOAuth.mockResolvedValue({
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    state: "signed",
    requestedScopes: ["drive.readonly", "calendar.readonly"],
    purpose: "读取你的 Google Workspace 工作资料",
    riskLevel: "high",
    dataDestination: "Google Workspace API",
    revokeMethod: "可在连接器详情中断开",
  });
});

afterEach(() => vi.restoreAllMocks());

function DrawerHarness() {
  const state = useGoogleWorkspaceConnector();
  return <GoogleWorkspaceConnectorDrawer open onOpenChange={vi.fn()} state={state} />;
}

describe("GoogleWorkspaceConnectorDrawer", () => {
  it("先展示服务端授权范围，用户确认后才打开 Google", async () => {
    const popup = { closed: false, location: { href: "" } };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    render(<DrawerHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "连接 Google Workspace" }));

    expect(await screen.findByText("drive.readonly")).toBeTruthy();
    expect(screen.getByText("读取你的 Google Workspace 工作资料")).toBeTruthy();
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "前往 Google 授权" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(popup.location.href).toContain("accounts.google.com");
  });

  it("使用页面展示的签名预览断开活动授权", async () => {
    sharedMocks.fetchGoogleWorkspaceConnection
      .mockResolvedValueOnce({ connection: { connectorId: "google-workspace", status: "connected", runtimeEnabled: true }, available: true })
      .mockResolvedValueOnce({ connection: null, available: true });
    governanceMocks.listOAuthGrants.mockResolvedValue({ grants: [grant] });
    governanceMocks.previewOAuthGrantRevocation.mockResolvedValue(preview);
    governanceMocks.revokeOAuthGrant.mockResolvedValue({ grantId: grant.grantId, status: "revoked", version: 2 });
    render(<DrawerHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "断开连接" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认断开" }));

    await waitFor(() => expect(governanceMocks.revokeOAuthGrant).toHaveBeenCalledWith(grant.grantId, {
      reason: "用户主动断开 Google Workspace",
      previewId: preview.previewId,
      baselineDigest: preview.baselineDigest,
      expiresAt: preview.expiresAt,
    }));
  });

  it("撤销存在阻断项时不能提交", async () => {
    sharedMocks.fetchGoogleWorkspaceConnection.mockResolvedValue({ connection: { connectorId: "google-workspace", status: "connected", runtimeEnabled: true }, available: true });
    governanceMocks.listOAuthGrants.mockResolvedValue({ grants: [grant] });
    governanceMocks.previewOAuthGrantRevocation.mockResolvedValue({
      ...preview,
      impact: { ...preview.impact, blockers: ["仍有运行中的任务"] },
    });
    render(<DrawerHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "断开连接" }));
    const confirm = await screen.findByRole("button", { name: "确认断开" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(governanceMocks.revokeOAuthGrant).not.toHaveBeenCalled();
  });
});
