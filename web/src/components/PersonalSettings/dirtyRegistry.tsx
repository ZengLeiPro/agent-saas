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
import { ensureAppHistoryIndex, readAppHistoryIndex } from "@/lib/appHistory";
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
  const historyTraversalRef = useRef<{ phase: "restore" | "resume"; step: number } | null>(null);
  const [version, setVersion] = useState(0);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
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
    if (![...entriesRef.current.values()].some((entry) => entry.dirty)) {
      navigation();
      return;
    }
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
      if (traversal?.phase === "restore") {
        event.stopImmediatePropagation();
        acceptedHistoryRef.current = target;
        historyTraversalRef.current = null;
        requestNavigation(() => {
          historyTraversalRef.current = { phase: "resume", step: traversal.step };
          window.history.go(traversal.step);
        });
        return;
      }
      if (traversal?.phase === "resume") {
        historyTraversalRef.current = null;
        acceptedHistoryRef.current = target;
        return;
      }
      if (event.isTrusted === false || ![...entriesRef.current.values()].some((entry) => entry.dirty)) {
        acceptedHistoryRef.current = target;
        return;
      }
      event.stopImmediatePropagation();
      const currentDepth = readPersonalSettingsHistoryState(acceptedHistoryRef.current.state)?.depth ?? 0;
      const targetDepth = readPersonalSettingsHistoryState(event.state)?.depth ?? 0;
      const appStep = target.appIndex !== null && acceptedHistoryRef.current.appIndex !== null
        ? target.appIndex - acceptedHistoryRef.current.appIndex
        : 0;
      const browserStep = target.browserIndex !== null && acceptedHistoryRef.current.browserIndex !== null
        ? target.browserIndex - acceptedHistoryRef.current.browserIndex
        : 0;
      const step = appStep || browserStep || targetDepth - currentDepth;
      if (!step) {
        // 旧版本留下的无索引 entry 无法判断方向；优先保住草稿，确认后在当前 entry 应用目标。
        const accepted = acceptedHistoryRef.current;
        window.history.replaceState(accepted.state, "", accepted.href);
        requestNavigation(() => {
          window.history.replaceState(target.state, "", target.href);
          notifyRouteChange(target.state);
        });
        return;
      }
      historyTraversalRef.current = { phase: "restore", step };
      window.history.go(-step);
    };
    window.addEventListener("popstate", guardHistoryNavigation, true);
    return () => window.removeEventListener("popstate", guardHistoryNavigation, true);
  }, [requestNavigation]);

  const continueNavigation = useCallback(() => {
    const navigation = pendingNavigation;
    setPendingNavigation(null);
    navigation?.();
  }, [pendingNavigation]);

  const saveAndContinue = useCallback(async () => {
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
      setSaving(false);
    }
  }, [continueNavigation]);

  const discardAndContinue = useCallback(async () => {
    for (const entry of [...entriesRef.current.values()].filter((item) => item.dirty)) {
      await entry.discard();
      clearSettingsDraft(entry.id);
    }
    continueNavigation();
  }, [continueNavigation]);

  const value = useMemo(() => ({ register }), [register]);

  return (
    <DirtyRegistryContext.Provider value={value}>
      {children({ dirty, requestNavigation })}
      <Dialog open={pendingNavigation !== null} onOpenChange={(open) => { if (!open && !saving) setPendingNavigation(null); }}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>有未保存的更改</DialogTitle>
            <DialogDescription>
              {dirtyEntries.map((entry) => entry.label).join("、")}尚未保存。保存、放弃更改，或留在当前页面继续编辑。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-between">
            <Button type="button" variant="ghost" onClick={() => setPendingNavigation(null)} disabled={saving}>取消</Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => { void discardAndContinue(); }} disabled={saving}>放弃更改</Button>
              <Button type="button" onClick={() => { void saveAndContinue(); }} disabled={saving}>{saving ? "正在保存" : "保存并继续"}</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DirtyRegistryContext.Provider>
  );
}
