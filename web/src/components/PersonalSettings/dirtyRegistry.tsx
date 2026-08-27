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

const DIRTY_HISTORY_ENTRY_PREFIX = "__settingsDirtyHistoryEntry_";
const activeDirtyHistoryEntryIds = new Set<string>();
let dirtyHistoryEntrySequence = 0;

interface HistoryPoint {
  href: string;
  state: unknown;
  appIndex: number | null;
  browserIndex: number | null;
  entryId: string | null;
}

function currentHistoryPoint(state: unknown = window.history.state): HistoryPoint {
  return {
    href: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    state,
    appIndex: readAppHistoryIndex(state),
    browserIndex: historyIndex(),
    entryId: null,
  };
}

function isHistoryStateRecord(state: unknown): state is Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return false;
  const prototype = Object.getPrototypeOf(state);
  return prototype === Object.prototype || prototype === null;
}

function stripDirtyHistoryEntryIds(state: unknown, ownedEntryId?: string): unknown {
  if (!isHistoryStateRecord(state)) return state;
  const markerKeys = Object.keys(state).filter((key) => (
    key.startsWith(DIRTY_HISTORY_ENTRY_PREFIX)
      && (ownedEntryId ? key === ownedEntryId : !activeDirtyHistoryEntryIds.has(key))
  ));
  if (markerKeys.length === 0) return state;
  const cleanState = structuredClone(state);
  markerKeys.forEach((key) => delete cleanState[key]);
  return cleanState;
}

function tagCurrentHistoryPoint(point: HistoryPoint): HistoryPoint {
  if (!isHistoryStateRecord(point.state)) return point;
  const entryId = `${DIRTY_HISTORY_ENTRY_PREFIX}${Date.now().toString(36)}_${++dirtyHistoryEntrySequence}`;
  const cleanState = stripDirtyHistoryEntryIds(point.state) as Record<string, unknown>;
  const taggedState = structuredClone(cleanState);
  taggedState[entryId] = true;
  activeDirtyHistoryEntryIds.add(entryId);
  window.history.replaceState(taggedState, "", point.href);
  // ref 保留原始 clean state；entryId 只用于在物理槽中精确定位，绝不复制到其他 entry。
  return { ...point, state: cleanState, appIndex: readAppHistoryIndex(cleanState), entryId };
}

function cleanCurrentHistoryPoint(point: HistoryPoint, entryId: string | null): HistoryPoint {
  if (!entryId) return point;
  activeDirtyHistoryEntryIds.delete(entryId);
  if (!isHistoryStateRecord(point.state) || point.state[entryId] !== true) return point;
  const state = stripDirtyHistoryEntryIds(point.state, entryId);
  window.history.replaceState(state, "", point.href);
  return currentHistoryPoint(state);
}

function historyStep(from: HistoryPoint, to: HistoryPoint): number {
  const browserStep = from.browserIndex !== null && to.browserIndex !== null ? to.browserIndex - from.browserIndex : 0;
  const appStep = from.appIndex !== null && to.appIndex !== null ? to.appIndex - from.appIndex : 0;
  const fromDepth = readPersonalSettingsHistoryState(from.state)?.depth ?? 0;
  const toDepth = readPersonalSettingsHistoryState(to.state)?.depth ?? 0;
  return browserStep || appStep || toDepth - fromDepth;
}

function sameHistoryState(
  actual: unknown,
  expected: unknown,
  actualToExpected = new WeakMap<object, object>(),
  expectedToActual = new WeakMap<object, object>(),
): boolean {
  if (Object.is(actual, expected)) return true;
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") return false;
  const knownExpected = actualToExpected.get(actual);
  const knownActual = expectedToActual.get(expected);
  if (knownExpected || knownActual) return knownExpected === expected && knownActual === actual;
  actualToExpected.set(actual, expected);
  expectedToActual.set(expected, actual);
  const compare = (left: unknown, right: unknown) => (
    sameHistoryState(left, right, actualToExpected, expectedToActual)
  );
  if (actual instanceof Date || expected instanceof Date) {
    return actual instanceof Date && expected instanceof Date && actual.getTime() === expected.getTime();
  }
  if (actual instanceof RegExp || expected instanceof RegExp) {
    return actual instanceof RegExp && expected instanceof RegExp
      && actual.source === expected.source && actual.flags === expected.flags;
  }
  if (actual instanceof ArrayBuffer || expected instanceof ArrayBuffer) {
    if (!(actual instanceof ArrayBuffer) || !(expected instanceof ArrayBuffer)) return false;
    const left = new Uint8Array(actual);
    const right = new Uint8Array(expected);
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  if (ArrayBuffer.isView(actual) || ArrayBuffer.isView(expected)) {
    return ArrayBuffer.isView(actual) && ArrayBuffer.isView(expected)
      && actual.constructor === expected.constructor
      && actual.byteOffset === expected.byteOffset
      && actual.byteLength === expected.byteLength
      && compare(actual.buffer, expected.buffer);
  }
  if (actual instanceof Map || expected instanceof Map) {
    if (!(actual instanceof Map) || !(expected instanceof Map) || actual.size !== expected.size) return false;
    const left = [...actual.entries()];
    const right = [...expected.entries()];
    return left.every(([key, value], index) => compare(key, right[index][0]) && compare(value, right[index][1]));
  }
  if (actual instanceof Set || expected instanceof Set) {
    if (!(actual instanceof Set) || !(expected instanceof Set) || actual.size !== expected.size) return false;
    const right = [...expected.values()];
    return [...actual.values()].every((value, index) => compare(value, right[index]));
  }
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    return actualKeys.length === expectedKeys.length && actualKeys.every((key) => (
      Object.prototype.hasOwnProperty.call(expected, key)
        && compare(
          (actual as unknown as Record<string, unknown>)[key],
          (expected as unknown as Record<string, unknown>)[key],
        )
    ));
  }
  if (!isHistoryStateRecord(actual) || !isHistoryStateRecord(expected)) return false;
  const actualEntries = Object.entries(actual).filter(([key]) => !key.startsWith(DIRTY_HISTORY_ENTRY_PREFIX));
  const expectedEntries = Object.entries(expected).filter(([key]) => !key.startsWith(DIRTY_HISTORY_ENTRY_PREFIX));
  return actualEntries.length === expectedEntries.length && actualEntries.every(([key, value]) => (
    Object.prototype.hasOwnProperty.call(expected, key) && compare(value, expected[key])
  ));
}

function sameHistoryPoint(actual: HistoryPoint, expected: HistoryPoint): boolean {
  if (expected.entryId) return isHistoryStateRecord(actual.state) && actual.state[expected.entryId] === true;
  const comparisons = [actual.href === expected.href];
  let hasCoordinate = false;
  if (actual.appIndex !== null && expected.appIndex !== null) {
    comparisons.push(actual.appIndex === expected.appIndex);
    hasCoordinate = true;
  }
  if (actual.browserIndex !== null && expected.browserIndex !== null) {
    comparisons.push(actual.browserIndex === expected.browserIndex);
    hasCoordinate = true;
  }
  const actualDepth = readPersonalSettingsHistoryState(actual.state)?.depth;
  const expectedDepth = readPersonalSettingsHistoryState(expected.state)?.depth;
  if (actualDepth !== undefined && expectedDepth !== undefined) {
    comparisons.push(actualDepth === expectedDepth);
    hasCoordinate = true;
  }
  if (!hasCoordinate) comparisons.push(sameHistoryState(actual.state, expected.state));
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
  const acceptedHistoryRef = useRef<HistoryPoint>(typeof window === "undefined"
    ? { href: "/", state: null, appIndex: null, browserIndex: null, entryId: null }
    : currentHistoryPoint());
  const historyTraversalRef = useRef<{
    phase: "restore" | "resume";
    step: number;
    accepted: HistoryPoint;
    target: HistoryPoint;
    remaining: number;
    restoreDelta: number;
    pendingDelta: number;
    probeOpposite?: boolean;
    searchDirection: number;
    ignore?: boolean;
  } | null>(null);
  const ambiguousHistoryRef = useRef<{
    accepted: { href: string; state: unknown };
    displaced: { href: string; state: unknown };
    preserveForward: boolean;
  } | null>(null);
  const traversalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (isHistoryStateRecord(window.history.state)) ensureAppHistoryIndex();
    acceptedHistoryRef.current = currentHistoryPoint();
  }, []);

  useEffect(() => {
    const current = currentHistoryPoint();
    if (!dirty) {
      const entryId = acceptedHistoryRef.current.entryId;
      if (entryId) acceptedHistoryRef.current = cleanCurrentHistoryPoint(current, entryId);
      return;
    }
    // marker 只在本轮 dirty 存活；恢复命中、dirty 结束或 Boundary 卸载都会清理。
    const tagged = tagCurrentHistoryPoint(current);
    acceptedHistoryRef.current = tagged;
    return () => {
      const active = currentHistoryPoint();
      const cleaned = cleanCurrentHistoryPoint(active, tagged.entryId);
      if (sameHistoryPoint(active, tagged)) acceptedHistoryRef.current = cleaned;
    };
  }, [dirty]);

  const beginAmbiguousNavigation = useCallback((
    accepted: HistoryPoint,
    displaced: HistoryPoint,
    destination: HistoryPoint,
    preserveForward = false,
  ) => {
    if (traversalTimeoutRef.current) clearTimeout(traversalTimeoutRef.current);
    traversalTimeoutRef.current = null;
    historyTraversalRef.current = null;
    ambiguousHistoryRef.current = { accepted, displaced, preserveForward };
    window.history.replaceState(accepted.state, "", accepted.href);
    acceptedHistoryRef.current = currentHistoryPoint(accepted.state);
    requestNavigation(() => {
      window.history.replaceState(destination.state, "", destination.href);
      notifyRouteChange(destination.state);
    });
  }, [requestNavigation]);

  useEffect(() => {
    const clearTraversalTimeout = () => {
      if (traversalTimeoutRef.current) clearTimeout(traversalTimeoutRef.current);
      traversalTimeoutRef.current = null;
    };
    const failTraversal = (traversal: NonNullable<typeof historyTraversalRef.current>) => {
      const displaced = currentHistoryPoint();
      clearTraversalTimeout();
      historyTraversalRef.current = null;
      if (!traversal.ignore) {
        beginAmbiguousNavigation(traversal.accepted, displaced, traversal.target, true);
        return;
      }
      window.history.replaceState(traversal.accepted.state, "", traversal.accepted.href);
      acceptedHistoryRef.current = currentHistoryPoint(traversal.accepted.state);
      const continuation = continuationAfterRestoreRef.current;
      continuationAfterRestoreRef.current = null;
      continuation?.();
    };
    const continueTraversal = (
      traversal: NonNullable<typeof historyTraversalRef.current>,
      delta: number,
    ) => {
      clearTraversalTimeout();
      const nextTraversal = { ...traversal, pendingDelta: delta };
      historyTraversalRef.current = nextTraversal;
      window.history.go(delta);
      traversalTimeoutRef.current = setTimeout(() => {
        if (historyTraversalRef.current !== nextTraversal) return;
        if (nextTraversal.phase === "restore" && nextTraversal.probeOpposite) {
          continueTraversal({
            ...nextTraversal,
            pendingDelta: 0,
            probeOpposite: false,
            searchDirection: 1,
          }, -nextTraversal.restoreDelta + 1);
          return;
        }
        failTraversal(nextTraversal);
      }, 1_500);
    };

    // popstate 触发时 URL 已移动：先恢复 accepted entry 再弹框，继续时重放原目标。
    const guardHistoryNavigation = (event: PopStateEvent) => {
      clearTraversalTimeout();
      let target = currentHistoryPoint(event.state);
      const traversal = historyTraversalRef.current;
      if (traversal) {
        const activeTraversal = traversal.phase === "restore"
          ? { ...traversal, restoreDelta: traversal.restoreDelta + traversal.pendingDelta, pendingDelta: 0 }
          : { ...traversal, pendingDelta: 0 };
        if (activeTraversal.phase === "resume") {
          // resume 使用 restore 阶段实际走过的物理距离反向重放；首个事件就是原始目标。
          historyTraversalRef.current = null;
          acceptedHistoryRef.current = target;
          return;
        }
        if (!sameHistoryPoint(target, activeTraversal.accepted)) {
          event.stopImmediatePropagation();
          if (activeTraversal.remaining <= 0) {
            failTraversal(activeTraversal);
            return;
          }
          const correction = historyStep(target, activeTraversal.accepted);
          // 无坐标时先逐槽扫描整个 Back 方向；只有到边界无事件，timeout 才越过起点改扫 Forward。
          const delta = correction || activeTraversal.searchDirection;
          if (!delta) {
            failTraversal(activeTraversal);
            return;
          }
          continueTraversal({ ...activeTraversal, remaining: activeTraversal.remaining - 1 }, delta);
          return;
        }
        event.stopImmediatePropagation();
        acceptedHistoryRef.current = activeTraversal.accepted;
        historyTraversalRef.current = null;
        if (activeTraversal.ignore) {
          acceptedHistoryRef.current = cleanCurrentHistoryPoint(target, activeTraversal.accepted.entryId);
          const continuation = continuationAfterRestoreRef.current;
          continuationAfterRestoreRef.current = null;
          continuation?.();
          return;
        }
        requestNavigation(() => {
          const resumeDelta = activeTraversal.accepted.browserIndex !== null && activeTraversal.target.browserIndex !== null
            ? activeTraversal.step
            : -activeTraversal.restoreDelta;
          const resume = {
            ...activeTraversal,
            phase: "resume" as const,
            step: resumeDelta,
            accepted: acceptedHistoryRef.current,
            remaining: Math.max(1, window.history.length),
            pendingDelta: 0,
            probeOpposite: false,
            searchDirection: Math.sign(resumeDelta),
          };
          continueTraversal(resume, resumeDelta);
        });
        return;
      }
      const activeEntryId = acceptedHistoryRef.current.entryId;
      const hasActiveMarker = Boolean(activeEntryId && isHistoryStateRecord(target.state)
        && target.state[activeEntryId] === true);
      if (!hasActiveMarker && isHistoryStateRecord(target.state)
        && Object.keys(target.state).some((key) => key.startsWith(DIRTY_HISTORY_ENTRY_PREFIX))) {
        const cleanState = stripDirtyHistoryEntryIds(target.state);
        window.history.replaceState(cleanState, "", target.href);
        target = currentHistoryPoint(cleanState);
      }
      if (event.isTrusted === false) {
        // route 同步使用 synthetic popstate；仍在 dirty accepted 槽时必须保留其唯一 marker。
        if (!actionInFlightRef.current && !hasActiveMarker) acceptedHistoryRef.current = target;
        return;
      }
      if (!actionInFlightRef.current && ![...entriesRef.current.values()].some((entry) => entry.dirty)) {
        acceptedHistoryRef.current = target;
        return;
      }
      event.stopImmediatePropagation();
      const accepted = acceptedHistoryRef.current;
      const step = historyStep(accepted, target);
      const delta = step ? -step : -1;
      continueTraversal({
        phase: "restore",
        step,
        accepted,
        target,
        remaining: Math.max(1, window.history.length),
        restoreDelta: 0,
        pendingDelta: 0,
        probeOpposite: !step,
        searchDirection: step ? -Math.sign(step) : -1,
        ignore: actionInFlightRef.current || undefined,
      }, delta);
    };
    window.addEventListener("popstate", guardHistoryNavigation, true);
    return () => {
      clearTraversalTimeout();
      window.removeEventListener("popstate", guardHistoryNavigation, true);
    };
  }, [beginAmbiguousNavigation, requestNavigation]);

  const cancelNavigation = useCallback(() => {
    const ambiguous = ambiguousHistoryRef.current;
    ambiguousHistoryRef.current = null;
    if (ambiguous && !ambiguous.preserveForward) {
      // 普通无坐标 fallback：还原 displaced 后新增 fresh accepted，且绝不复制旧 marker。
      window.history.replaceState(ambiguous.displaced.state, "", ambiguous.displaced.href);
      const cleanAcceptedState = stripDirtyHistoryEntryIds(ambiguous.accepted.state);
      const acceptedState = isHistoryStateRecord(cleanAcceptedState) ? cleanAcceptedState : {};
      pushAppHistoryState(acceptedState, ambiguous.accepted.href);
      acceptedHistoryRef.current = tagCurrentHistoryPoint(currentHistoryPoint());
    }
    // traversal 超时已在当前物理槽恢复 accepted；取消时保持原位，避免 push 截断 Forward 栈。
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
    const accepted = acceptedHistoryRef.current;
    const current = currentHistoryPoint();
    if (sameHistoryPoint(current, accepted)) {
      acceptedHistoryRef.current = cleanCurrentHistoryPoint(current, accepted.entryId);
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
