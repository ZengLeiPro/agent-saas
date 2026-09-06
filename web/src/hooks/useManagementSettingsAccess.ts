import { useCallback, useEffect, useRef, useState } from "react";
import type { ManagementSnapshotResponseV1 } from "@agent/shared/types/governance";

export type ManagementSettingsAccessStatus = "loading" | "refreshing" | "ready" | "error";
export interface ManagementSettingsAccess {
  status: ManagementSettingsAccessStatus;
  personalAllowed: true;
  /** Entry-only authorization; downstream tenant operations remain explicitly scoped and server-authorized. */
  tenantEntryAllowed: boolean;
  /** Entry-only authorization for the platform management workspace. */
  platformEntryAllowed: boolean;
  retry: () => void;
}
interface ManagementSettingsUser { id: string; tenantId: string }
interface ManagementSettingsAccessOptions {
  user: ManagementSettingsUser | null | undefined;
  authLoading: boolean;
  authEnabled: boolean;
  active: boolean;
}
type AccessState = Omit<ManagementSettingsAccess, "personalAllowed" | "retry"> & { contextKey: string };
type RequestTrigger = { sequence: number; preserveReady: boolean };
const FOCUS_REVALIDATE_TTL_MS = 30_000;
const CLOSED_ACCESS = { tenantEntryAllowed: false, platformEntryAllowed: false };
const EXPECTED_DECISIONS = [
  { action: "settings.personal.view", scope: { kind: "personal" } },
  { action: "settings.tenant.view", scope: { kind: "tenant" } },
  { action: "settings.tenant.view", scope: { kind: "platform" } },
  { action: "settings.platform.view", scope: { kind: "platform" } },
] as const;

type ExpectedDecision = (typeof EXPECTED_DECISIONS)[number];
type SnapshotDecision = ManagementSnapshotResponseV1["decisions"][number];

function decisionMatches(decision: SnapshotDecision, expected: ExpectedDecision, tenantId: string): boolean {
  if (decision.action !== expected.action || decision.scope.kind !== expected.scope.kind) return false;
  return expected.scope.kind !== "tenant"
    || (decision.scope.kind === "tenant" && decision.scope.tenantId === tenantId);
}

function verifiedAllowed(
  response: ManagementSnapshotResponseV1,
  user: ManagementSettingsUser,
): Pick<AccessState, "tenantEntryAllowed" | "platformEntryAllowed"> {
  if (response.subject.userId !== user.id || response.subject.tenantId !== user.tenantId) {
    throw new Error("Management snapshot subject does not match the current user");
  }
  if (response.decisions.length !== EXPECTED_DECISIONS.length) {
    throw new Error("Management snapshot must contain exactly four decisions");
  }
  const decisions = EXPECTED_DECISIONS.map((expected) => {
    const matches = response.decisions.filter((decision) => decisionMatches(decision, expected, user.tenantId));
    if (matches.length !== 1) throw new Error("Management snapshot omitted an exact scoped decision");
    return matches[0];
  });
  const platformTenantEntryAllowed = decisions[2].allowed === true
    && decisions[2].constraints.includes("EXPLICIT_TENANT_SCOPE");
  return {
    // These booleans only authorize entering a management workspace. Every downstream
    // tenant read/write still carries an explicit tenant scope and is authorized by the server.
    tenantEntryAllowed: decisions[1].allowed === true || platformTenantEntryAllowed,
    platformEntryAllowed: decisions[3].allowed === true,
  };
}

function mayRefresh(state: AccessState, contextKey: string): boolean {
  return state.contextKey === contextKey && (state.status === "ready" || state.status === "refreshing");
}

function isTransientRevalidationError(error: unknown): boolean {
  if (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) return true;
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && (status === 408 || status === 429 || status >= 500);
}

export function useManagementSettingsAccess({
  user, authLoading, authEnabled, active,
}: ManagementSettingsAccessOptions): ManagementSettingsAccess {
  const contextKey = authLoading ? "auth-loading" : `${authEnabled}:${user?.id ?? ""}:${user?.tenantId ?? ""}`;
  const [requestTrigger, setRequestTrigger] = useState<RequestTrigger>({ sequence: 0, preserveReady: false });
  const [state, setState] = useState<AccessState>({ status: "loading", ...CLOSED_ACCESS, contextKey });
  const stateRef = useRef(state);
  const lastVerifiedRef = useRef<{ contextKey: string; at: number } | null>(null);
  const triggerRef = useRef<{ contextKey: string; active: boolean; sequence: number } | null>(null);
  const activeRef = useRef(active);
  stateRef.current = state;
  activeRef.current = active;

  const retry = useCallback(() => {
    setState({ status: "loading", ...CLOSED_ACCESS, contextKey });
    setRequestTrigger(({ sequence }) => ({ sequence: sequence + 1, preserveReady: false }));
  }, [contextKey]);

  useEffect(() => {
    const onFocus = () => {
      if (!activeRef.current) return;
      const current = stateRef.current;
      if (current.status === "loading" || current.status === "refreshing") return;
      const lastVerified = lastVerifiedRef.current;
      if (lastVerified?.contextKey === contextKey && Date.now() - lastVerified.at < FOCUS_REVALIDATE_TTL_MS) return;
      setState((current) => mayRefresh(current, contextKey)
        ? { ...current, status: "refreshing" }
        : { status: "loading", ...CLOSED_ACCESS, contextKey });
      setRequestTrigger(({ sequence }) => ({ sequence: sequence + 1, preserveReady: true }));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [contextKey]);

  useEffect(() => {
    const previous = triggerRef.current;
    const contextChanged = previous === null || previous.contextKey !== contextKey;
    const entering = previous !== null && active && !previous.active;
    const sequenceChanged = previous !== null && previous.sequence !== requestTrigger.sequence;
    const shouldRequest = contextChanged || entering || sequenceChanged;
    triggerRef.current = { contextKey, active, sequence: requestTrigger.sequence };
    if (!shouldRequest) return;

    let current = true;
    const preserveReady = !contextChanged
      && (entering || (sequenceChanged && requestTrigger.preserveReady))
      && mayRefresh(stateRef.current, contextKey);
    setState((existing) => preserveReady
      ? { ...existing, status: "refreshing" }
      : { status: "loading", ...CLOSED_ACCESS, contextKey });
    if (authLoading) return () => { current = false; };
    if (!authEnabled || !user?.id || !user.tenantId) {
      setState({ status: "ready", ...CLOSED_ACCESS, contextKey });
      return () => { current = false; };
    }
    void import("@agent/shared/lib/governanceApi")
      .then(({ fetchManagementSnapshot }) => fetchManagementSnapshot({
        decisions: [
          { action: "settings.personal.view", scope: { kind: "personal" } },
          { action: "settings.tenant.view", scope: { kind: "tenant", tenantId: user.tenantId } },
          { action: "settings.tenant.view", scope: { kind: "platform" } },
          { action: "settings.platform.view", scope: { kind: "platform" } },
        ],
      }))
      .then((response) => {
        const allowed = verifiedAllowed(response, user);
        if (current) {
          lastVerifiedRef.current = { contextKey, at: Date.now() };
          setState({ status: "ready", ...allowed, contextKey });
        }
      })
      .catch((error: unknown) => {
        if (!current) return;
        // 同一身份下的后台重验失败不等于权限被撤销；入口权限只用于展示，后续 API 仍逐次鉴权。
        // 首次验证和身份切换仍然严格 fail-closed。
        if (preserveReady && isTransientRevalidationError(error) && mayRefresh(stateRef.current, contextKey)) {
          setState((existing) => ({ ...existing, status: "ready" }));
        } else {
          setState({ status: "error", ...CLOSED_ACCESS, contextKey });
        }
      });
    return () => { current = false; };
  }, [active, authEnabled, authLoading, contextKey, requestTrigger, user?.id, user?.tenantId]);

  const previousTrigger = triggerRef.current;
  const entering = active && previousTrigger !== null && !previousTrigger.active;
  const sameContext = state.contextKey === contextKey;
  const effectiveState = !sameContext
    ? { status: "loading" as const, ...CLOSED_ACCESS }
    : entering && mayRefresh(state, contextKey)
      ? { status: "refreshing" as const, tenantEntryAllowed: state.tenantEntryAllowed, platformEntryAllowed: state.platformEntryAllowed }
      : entering ? { status: "loading" as const, ...CLOSED_ACCESS } : state;
  const { contextKey: _stateContextKey, ...accessState } = effectiveState as AccessState;
  return { ...accessState, personalAllowed: true, retry };
}
