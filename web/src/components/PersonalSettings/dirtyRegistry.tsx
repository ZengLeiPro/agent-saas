import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";
import { ensureAppHistoryIndex, pushAppHistoryState, readAppHistoryIndex } from "@/lib/appHistory";
import { notifyRouteChange, readPersonalSettingsHistoryState } from "@/lib/urlSync";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const DRAFT_PREFIX = "agent.personal-settings.draft.v2.";

export interface SettingsDirtyEntry {
  id: string;
  label: string;
  dirty: boolean;
  save: () => void | Promise<void>;
  discard: () => void | Promise<void>;
  /** Secret entries are guarded in-memory only and can never enter Web Storage. */
  secret?: boolean;
  draft?: unknown;
}

export interface SettingsDirtyController {
  dirty: boolean;
  requestNavigation: (navigation: () => void) => void;
}

interface DirtyRegistryContextValue {
  register: (entry: SettingsDirtyEntry) => () => void;
}

const DirtyRegistryContext = createContext<DirtyRegistryContextValue | null>(null);

function draftKey(id: string): string {
  return `${DRAFT_PREFIX}${id}`;
}

function historyIndex(): number | null {
  const index = (window as Window & { navigation?: { currentEntry?: { index?: number } } }).navigation?.currentEntry?.index;
  return typeof index === "number" ? index : null;
}

interface HistoryPoint {
  href: string;
  state: unknown;
  appIndex: number | null;
  browserIndex: number | null;
}

function historyStep(from: HistoryPoint, to: HistoryPoint): number {
  const browserStep = from.browserIndex !== null && to.browserIndex !== null ? to.browserIndex - from.browserIndex : 0;
  const appStep = from.appIndex !== null && to.appIndex !== null ? to.appIndex - from.appIndex : 0;
  const fromDepth = readPersonalSettingsHistoryState(from.state)?.depth ?? 0;
  const toDepth = readPersonalSettingsHistoryState(to.state)?.depth ?? 0;
  return browserStep || appStep || toDepth - fromDepth;
}

function sameHistoryPoint(actual: HistoryPoint, expected: HistoryPoint): boolean {
  const comparisons = [actual.href === expected.href];
  if (actual.appIndex !== null && expected.appIndex !== null) comparisons.push(actual.appIndex === expected.appIndex);
  if (actual.browserIndex !== null && expected.browserIndex !== null) comparisons.push(actual.browserIndex === expected.browserIndex);
  const actualDepth = readPersonalSettingsHistoryState(actual.state)?.depth;
  const expectedDepth = readPersonalSettingsHistoryState(expected.state)?.depth;
  if (actualDepth !== undefined && expectedDepth !== undefined) comparisons.push(actualDepth === expectedDepth);
  return comparisons.every(Boolean);
}

const SENSITIVE_DRAFT_KEYS = new Set([
  "secret", "secretref", "clientsecret", "password", "apikey", "token", "accesstoken",
  "refreshtoken", "idtoken", "authtoken", "bearertoken", "verifier",
]);

function scrubSensitiveDraftFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSensitiveDraftFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !SENSITIVE_DRAFT_KEYS.has(key.replace(/[_-]/g, "").toLowerCase()))
    .map(([key, item]) => [key, scrubSensitiveDraftFields(item)]));
}

export function persistSettingsDraft(id: string, draft: unknown, options: { secret?: boolean } = {}): void {
  if (options.secret || typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(draftKey(id), JSON.stringify(scrubSensitiveDraftFields(draft)));
  } catch {
    // Draft recovery is best effort and must never block settings editing.
  }
}

export function restoreSettingsDraft<T>(id: string, options: { secret?: boolean } = {}): T | null {
  if (options.secret || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(draftKey(id));
    return raw === null ? null : JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function clearSettingsDraft(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(draftKey(id));
  } catch {
    // Best effort.
  }
}

/** Registers one editor with the modal-wide dirty guard and non-secret recovery store. */
export function useSettingsDirtyEntry(entry: SettingsDirtyEntry): void {
  const registry = useContext(DirtyRegistryContext);
  const latest = useRef(entry);
  latest.current = entry;

  const draftFingerprint = useMemo(() => {
    try { return JSON.stringify(entry.draft); } catch { return "[unserializable]"; }
  }, [entry.draft]);

  useEffect(() => {
    if (!registry) return;
    return registry.register({ ...entry, save: () => latest.current.save(), discard: () => latest.current.discard() });
  }, [registry, entry.id, entry.label, entry.dirty, entry.secret, draftFingerprint]);

  useEffect(() => {
    if (!entry.dirty) {
      clearSettingsDraft(entry.id);
      return;
    }
    if (entry.draft !== undefined) persistSettingsDraft(entry.id, entry.draft, { secret: entry.secret });
  }, [entry.id, entry.dirty, entry.draft, entry.secret]);
}

export function SettingsDirtyBoundary({
  children,
}: {
  children: (controller: SettingsDirtyController) => ReactNode;
}) {
  const entriesRef = useRef(new Map<string, SettingsDirtyEntry>());
  const acceptedHistoryRef = useRef(typeof window === "undefined"
    ? { href: "/", state: null, appIndex: null, browserIndex: null }
    : {
      href: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      state: window.history.state,
      appIndex: readAppHistoryIndex(),
      browserIndex: historyIndex(),
    });
  const historyTraversalRef = useRef<{
    phase: "restore" | "resume";
    step: number;
    accepted: HistoryPoint;
    target: HistoryPoint;
    ignore?: boolean;
  } | null>(null);
  const ambiguousHistoryRef = useRef<{
    accepted: { href: string; state: unknown };
    target: { href: string; state: unknown };
  } | null>(null);
  const [version, setVersion] = useState(0);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const pendingNavigationRef = useRef<(() => void) | null>(null);
  const actionInFlightRef = useRef(false);
  const continuationAfterRestoreRef = useRef<(() => void) | null>(null);
  const [actionInFlight, setActionInFlight] = useState(false);
  const [saving, setSaving] = useState(false);

  const register = useCallback((entry: SettingsDirtyEntry) => {
    entriesRef.current.set(entry.id, entry);
    setVersion((current) => current + 1);
    return () => {
      if (entriesRef.current.get(entry.id) === entry) {
        entriesRef.current.delete(entry.id);
        setVersion((current) => current + 1);
      }
    };
  }, []);

  const dirtyEntries = useMemo(
    () => [...entriesRef.current.values()].filter((entry) => entry.dirty),
    // version intentionally snapshots the mutable registry.
    [version],
  );
  const dirty = dirtyEntries.length > 0;

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const requestNavigation = useCallback((navigation: () => void) => {
    if (actionInFlightRef.current) return;
    if (![...entriesRef.current.values()].some((entry) => entry.dirty)) {
      navigation();
      return;
    }
    pendingNavigationRef.current = navigation;
    setPendingNavigation(() => navigation);
  }, []);

  useEffect(() => {
    ensureAppHistoryIndex();
    acceptedHistoryRef.current = {
      href: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      state: window.history.state,
      appIndex: readAppHistoryIndex(),
      browserIndex: historyIndex(),
    };
  });

  useEffect(() => {
    // popstate 触发时 URL 已移动：先按 settings depth 原路返回当前页再弹框，继续时重放原步数。
    const guardHistoryNavigation = (event: PopStateEvent) => {
      const target = {
        href: `${window.location.pathname}${window.location.search}${window.location.hash}`,
        state: event.state,
        appIndex: readAppHistoryIndex(event.state),
        browserIndex: historyIndex(),
      };
      const traversal = historyTraversalRef.current;
      if (traversal) {
        const expected = traversal.phase === "restore" ? traversal.accepted : traversal.target;
        if (!sameHistoryPoint(target, expected)) {
          event.stopImmediatePropagation();
          const correction = historyStep(target, expected);
          if (correction) window.history.go(correction);
          return;
        }
        if (traversal.phase === "restore") {
          event.stopImmediatePropagation();
          acceptedHistoryRef.current = target;
          historyTraversalRef.current = null;
          if (traversal.ignore) {
            const continuation = continuationAfterRestoreRef.current;
            continuationAfterRestoreRef.current = null;
            continuation?.();
            return;
          }
          requestNavigation(() => {
            historyTraversalRef.current = { ...traversal, phase: "resume" };
            window.history.go(traversal.step);
          });
          return;
        }
        historyTraversalRef.current = null;
        acceptedHistoryRef.current = target;
        return;
      }
      if (event.isTrusted === false) {
        if (!actionInFlightRef.current) acceptedHistoryRef.current = target;
        return;
      }
      if (!actionInFlightRef.current && ![...entriesRef.current.values()].some((entry) => entry.dirty)) {
        acceptedHistoryRef.current = target;
        return;
      }
      event.stopImmediatePropagation();
      const accepted = acceptedHistoryRef.current;
      const step = historyStep(accepted, target);
      if (actionInFlightRef.current) {
        if (!step) {
          // 无法判断方向时保留刚到达的旧目标槽，再新增当前 accepted 页，不能再次吞掉目标。
          const accepted = acceptedHistoryRef.current;
          window.history.replaceState(target.state, "", target.href);
          const acceptedState = accepted.state && typeof accepted.state === "object"
            ? accepted.state as Record<string, unknown>
            : {};
          pushAppHistoryState(acceptedState, accepted.href);
          acceptedHistoryRef.current = {
            href: accepted.href,
            state: window.history.state,
            appIndex: readAppHistoryIndex(),
            browserIndex: historyIndex(),
          };
          return;
        }
        historyTraversalRef.current = { phase: "restore", step, accepted, target, ignore: true };
        window.history.go(-step);
        return;
      }
      if (!step) {
        // 旧版本留下的无索引 entry 无法判断方向；优先保住草稿，确认后在当前 entry 应用目标。
        const accepted = acceptedHistoryRef.current;
        ambiguousHistoryRef.current = { accepted, target };
        window.history.replaceState(accepted.state, "", accepted.href);
        requestNavigation(() => {
          window.history.replaceState(target.state, "", target.href);
          notifyRouteChange(target.state);
        });
        return;
      }
      historyTraversalRef.current = { phase: "restore", step, accepted, target };
      window.history.go(-step);
    };
    window.addEventListener("popstate", guardHistoryNavigation, true);
    return () => window.removeEventListener("popstate", guardHistoryNavigation, true);
  }, [requestNavigation]);

  const cancelNavigation = useCallback(() => {
    const ambiguous = ambiguousHistoryRef.current;
    ambiguousHistoryRef.current = null;
    if (ambiguous) {
      // 先还原被临时占用的旧目标 entry，再新增当前页；这样取消不会永久吞掉目标。
      window.history.replaceState(ambiguous.target.state, "", ambiguous.target.href);
      const acceptedState = ambiguous.accepted.state && typeof ambiguous.accepted.state === "object"
        ? ambiguous.accepted.state as Record<string, unknown>
        : {};
      pushAppHistoryState(acceptedState, ambiguous.accepted.href);
    }
    pendingNavigationRef.current = null;
    setPendingNavigation(null);
  }, []);

  const continueNavigation = useCallback(() => {
    const navigation = pendingNavigationRef.current;
    ambiguousHistoryRef.current = null;
    pendingNavigationRef.current = null;
    setPendingNavigation(null);
    if (historyTraversalRef.current?.phase === "restore" && historyTraversalRef.current.ignore) {
      continuationAfterRestoreRef.current = navigation;
      return;
    }
    navigation?.();
  }, []);

  const saveAndContinue = useCallback(async () => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setActionInFlight(true);
    setSaving(true);
    try {
      for (const entry of [...entriesRef.current.values()].filter((item) => item.dirty)) {
        await entry.save();
        clearSettingsDraft(entry.id);
      }
      continueNavigation();
    } catch {
      // Editors own their safe, user-facing save error. Keep the navigation blocked.
    } finally {
      actionInFlightRef.current = false;
      setActionInFlight(false);
      setSaving(false);
    }
  }, [continueNavigation]);

  const discardAndContinue = useCallback(async () => {
    if (actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setActionInFlight(true);
    try {
      for (const entry of [...entriesRef.current.values()].filter((item) => item.dirty)) {
        await entry.discard();
        clearSettingsDraft(entry.id);
      }
      continueNavigation();
    } finally {
      actionInFlightRef.current = false;
      setActionInFlight(false);
    }
  }, [continueNavigation]);

  const value = useMemo(() => ({ register }), [register]);

  return (
    <DirtyRegistryContext.Provider value={value}>
      {children({ dirty, requestNavigation })}
      <Dialog open={pendingNavigation !== null} onOpenChange={(open) => { if (!open && !actionInFlight) cancelNavigation(); }}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>有未保存的更改</DialogTitle>
            <DialogDescription>
              {dirtyEntries.map((entry) => entry.label).join("、")}尚未保存。保存、放弃更改，或留在当前页面继续编辑。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="ghost" onClick={cancelNavigation} disabled={actionInFlight}>取消</Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => { void discardAndContinue(); }} disabled={actionInFlight}>放弃更改</Button>
              <Button type="button" onClick={() => { void saveAndContinue(); }} disabled={actionInFlight}>{saving ? "正在保存" : "保存并继续"}</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DirtyRegistryContext.Provider>
  );
}
