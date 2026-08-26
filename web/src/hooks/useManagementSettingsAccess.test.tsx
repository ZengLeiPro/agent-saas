import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GovernancePersona, ManagementSnapshotResponseV1 } from "@agent/shared/types/governance";

const governanceApiMocks = vi.hoisted(() => ({ fetchManagementSnapshot: vi.fn() }));
vi.mock("@agent/shared/lib/governanceApi", () => governanceApiMocks);

import { useManagementSettingsAccess } from "./useManagementSettingsAccess";

const user = { id: "user-1", tenantId: "tenant-a" };

function snapshot(
  persona: GovernancePersona,
  subject: { id: string; tenantId: string },
  exactTenantAllowed: boolean,
  platformScopedTenantAllowed: boolean,
  platformEntryAllowed: boolean,
): ManagementSnapshotResponseV1 {
  const reason = { code: "PLATFORM_ADMIN_ALLOWED" as const, label: "判定", layer: "management_authority" as const };
  return {
    contractVersion: "v1",
    subject: { userId: subject.id, tenantId: subject.tenantId, persona, isOwner: false },
    decisions: [
      {
        action: "settings.personal.view", scope: { kind: "personal" }, allowed: true,
        reason: { code: "PERSONAL_SELF_ALLOWED", label: "允许", layer: "management_scope" }, constraints: ["SELF_ONLY"],
      },
      {
        action: "settings.tenant.view", scope: { kind: "tenant", tenantId: subject.tenantId }, allowed: exactTenantAllowed,
        reason, constraints: ["SAME_TENANT_ONLY"],
      },
      {
        action: "settings.tenant.view", scope: { kind: "platform" }, allowed: platformScopedTenantAllowed,
        reason, constraints: ["EXPLICIT_TENANT_SCOPE"],
      },
      {
        action: "settings.platform.view", scope: { kind: "platform" }, allowed: platformEntryAllowed,
        reason, constraints: ["PLATFORM_ONLY"],
      },
    ],
    policySnapshot: { membershipVersion: 1 },
    evaluatedAt: "2026-08-25T18:00:00.000Z",
  };
}

function options(overrides: Partial<Parameters<typeof useManagementSettingsAccess>[0]> = {}) {
  return { user, authLoading: false, authEnabled: true, active: true, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  governanceApiMocks.fetchManagementSnapshot.mockReset();
});

describe("useManagementSettingsAccess", () => {
  it.each([
    ["member", false, false, false, false, false],
    ["org_admin", true, false, false, true, false],
    ["platform_admin", false, true, true, true, true],
  ] as const)("验证四项 decision 并按 %s persona 的实际 decision 放行", async (
    persona, exactTenantAllowed, platformScopedTenantAllowed, platformEntryAllowed, expectedTenant, expectedPlatform,
  ) => {
    governanceApiMocks.fetchManagementSnapshot.mockResolvedValueOnce(
      snapshot(persona, user, exactTenantAllowed, platformScopedTenantAllowed, platformEntryAllowed),
    );
    const { result } = renderHook(() => useManagementSettingsAccess(options()));

    expect(result.current).toMatchObject({ status: "loading", personalAllowed: true, tenantEntryAllowed: false, platformEntryAllowed: false });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ tenantEntryAllowed: expectedTenant, platformEntryAllowed: expectedPlatform });
    expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledWith({
      decisions: [
        { action: "settings.personal.view", scope: { kind: "personal" } },
        { action: "settings.tenant.view", scope: { kind: "tenant", tenantId: "tenant-a" } },
        { action: "settings.tenant.view", scope: { kind: "platform" } },
        { action: "settings.platform.view", scope: { kind: "platform" } },
      ],
    });
  });

  it("platform-scope tenant allow 仅授权进入管理工作区", async () => {
    governanceApiMocks.fetchManagementSnapshot.mockResolvedValueOnce(snapshot("platform_admin", user, false, true, true));
    const { result } = renderHook(() => useManagementSettingsAccess(options()));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ tenantEntryAllowed: true, platformEntryAllowed: true });
  });

  it("platform-scope tenant allow 缺少精确约束时不贡献入口权限", async () => {
    const response = snapshot("platform_admin", user, false, true, true);
    response.decisions[2].constraints = ["PLATFORM_ONLY"];
    governanceApiMocks.fetchManagementSnapshot.mockResolvedValueOnce(response);
    const { result } = renderHook(() => useManagementSettingsAccess(options()));

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current).toMatchObject({ tenantEntryAllowed: false, platformEntryAllowed: true });
  });

  it("约束字段异常时 fail-closed", async () => {
    const response = snapshot("platform_admin", user, false, true, true);
    Reflect.deleteProperty(response.decisions[2], "constraints");
    governanceApiMocks.fetchManagementSnapshot.mockResolvedValueOnce(response);
    const { result } = renderHook(() => useManagementSettingsAccess(options()));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ tenantEntryAllowed: false, platformEntryAllowed: false });
  });

  it.each([
    ["userId", { id: "other-user", tenantId: user.tenantId }],
    ["tenantId", { id: user.id, tenantId: "other-tenant" }],
  ] as const)("subject.%s 错配时 fail-closed", async (_field, wrongSubject) => {
    governanceApiMocks.fetchManagementSnapshot.mockResolvedValueOnce(snapshot("platform_admin", wrongSubject, true, true, true));
    const { result } = renderHook(() => useManagementSettingsAccess(options()));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ tenantEntryAllowed: false, platformEntryAllowed: false });
  });

  it.each(["missing", "duplicate", "wrong-tenant"] as const)("四项 scoped decision 必须各恰好一条：%s", async (kind) => {
    const response = snapshot("platform_admin", user, true, true, true);
    if (kind === "missing") response.decisions.splice(0, 1);
    else if (kind === "duplicate") response.decisions.push(response.decisions[0]);
    else {
      const tenantDecision = response.decisions[1];
      if (tenantDecision.scope.kind === "tenant") tenantDecision.scope.tenantId = "other-tenant";
    }
    governanceApiMocks.fetchManagementSnapshot.mockResolvedValueOnce(response);
    const { result } = renderHook(() => useManagementSettingsAccess(options()));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ tenantEntryAllowed: false, platformEntryAllowed: false });
  });

  it("治理依赖失败时保持个人设置可用，并可重试一次", async () => {
    governanceApiMocks.fetchManagementSnapshot
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(snapshot("org_admin", user, true, false, false));
    const { result } = renderHook(() => useManagementSettingsAccess(options()));

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current).toMatchObject({ personalAllowed: true, tenantEntryAllowed: false, platformEntryAllowed: false });
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledTimes(2);
  });

  it("Auth 加载保持 loading，完成后无用户进入 ready 全 deny", async () => {
    const { result, rerender } = renderHook(
      (currentOptions) => useManagementSettingsAccess(currentOptions),
      { initialProps: options({ user: null, authLoading: true, active: true }) },
    );
    expect(result.current).toMatchObject({ status: "loading", tenantEntryAllowed: false, platformEntryAllowed: false });

    rerender(options({ user: null, authLoading: false, active: true }));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(governanceApiMocks.fetchManagementSnapshot).not.toHaveBeenCalled();
  });

  it("初次登录、进入、active focus 各请求一次，退出与 inactive focus 不请求", async () => {
    governanceApiMocks.fetchManagementSnapshot.mockResolvedValue(snapshot("org_admin", user, true, false, false));
    const { result, rerender } = renderHook(
      (currentOptions) => useManagementSettingsAccess(currentOptions),
      { initialProps: options({ active: false }) },
    );
    await waitFor(() => expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender(options({ active: true }));
    expect(result.current).toMatchObject({ status: "refreshing", tenantEntryAllowed: true });
    await waitFor(() => expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledTimes(2));
    rerender(options({ active: false }));
    act(() => window.dispatchEvent(new FocusEvent("focus")));
    expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledTimes(2);

    rerender(options({ active: true }));
    await waitFor(() => expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledTimes(3));
    act(() => window.dispatchEvent(new FocusEvent("focus")));
    await waitFor(() => expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledTimes(4));
  });

  it("focus 重验保留同 context 的旧 allow，deny 响应后立即关闭", async () => {
    const refreshed = deferred<ManagementSnapshotResponseV1>();
    governanceApiMocks.fetchManagementSnapshot
      .mockResolvedValueOnce(snapshot("org_admin", user, true, false, false))
      .mockReturnValueOnce(refreshed.promise);
    const { result } = renderHook(() => useManagementSettingsAccess(options()));
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", tenantEntryAllowed: true }));

    act(() => window.dispatchEvent(new FocusEvent("focus")));
    expect(result.current).toMatchObject({ status: "refreshing", tenantEntryAllowed: true });
    await act(async () => refreshed.resolve(snapshot("member", user, false, false, false)));
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", tenantEntryAllowed: false }));
  });

  it("同 context 并发重验的 stale response 不可覆盖新响应", async () => {
    const stale = deferred<ManagementSnapshotResponseV1>();
    const latest = deferred<ManagementSnapshotResponseV1>();
    governanceApiMocks.fetchManagementSnapshot
      .mockResolvedValueOnce(snapshot("org_admin", user, true, false, false))
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(latest.promise);
    const { result } = renderHook(() => useManagementSettingsAccess(options()));
    await waitFor(() => expect(result.current.status).toBe("ready"));

    act(() => window.dispatchEvent(new FocusEvent("focus")));
    await waitFor(() => expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledTimes(2));
    act(() => window.dispatchEvent(new FocusEvent("focus")));
    await waitFor(() => expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledTimes(3));
    await act(async () => latest.resolve(snapshot("platform_admin", user, false, true, true)));
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", tenantEntryAllowed: true, platformEntryAllowed: true }));

    await act(async () => stale.resolve(snapshot("member", user, false, false, false)));
    expect(result.current).toMatchObject({ status: "ready", tenantEntryAllowed: true, platformEntryAllowed: true });
  });

  it("active 与登录 context 同时变化只请求一次且立即 fail-closed", async () => {
    governanceApiMocks.fetchManagementSnapshot.mockResolvedValue(snapshot("platform_admin", user, false, true, true));
    const { result, rerender } = renderHook(
      (currentOptions) => useManagementSettingsAccess(currentOptions),
      { initialProps: options({ user: null, active: false }) },
    );
    await waitFor(() => expect(result.current.status).toBe("ready"));

    rerender(options({ user, active: true }));
    expect(result.current).toMatchObject({ status: "loading", tenantEntryAllowed: false, platformEntryAllowed: false });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledTimes(1);
  });

  it("忽略切换账号或租户后的 stale response", async () => {
    const nextUser = { id: "user-2", tenantId: "tenant-b" };
    const first = deferred<ManagementSnapshotResponseV1>();
    const second = deferred<ManagementSnapshotResponseV1>();
    governanceApiMocks.fetchManagementSnapshot.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result, rerender } = renderHook(
      ({ currentUser }) => useManagementSettingsAccess(options({ user: currentUser })),
      { initialProps: { currentUser: user } },
    );
    await waitFor(() => expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledTimes(1));

    rerender({ currentUser: nextUser });
    expect(result.current).toMatchObject({ status: "loading", tenantEntryAllowed: false, platformEntryAllowed: false });
    await waitFor(() => expect(governanceApiMocks.fetchManagementSnapshot).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve(snapshot("platform_admin", nextUser, false, true, true)));
    await waitFor(() => expect(result.current).toMatchObject({ status: "ready", tenantEntryAllowed: true, platformEntryAllowed: true }));

    await act(async () => first.resolve(snapshot("member", user, false, false, false)));
    expect(result.current).toMatchObject({ status: "ready", tenantEntryAllowed: true, platformEntryAllowed: true });
  });
});
