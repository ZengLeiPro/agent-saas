import { pushAppHistoryState, replaceAppHistoryState } from "@/lib/appHistory";
import { isAnalysisRoute } from "@/lib/analysisNavigation";
import { parseGovernanceUrl } from "@/lib/governanceNavigation";

const ANALYSIS_HISTORY_KEY = "analysisWorkspace";

export interface AnalysisHistoryState {
  source: string;
  depth: number;
}

export function readAnalysisHistoryState(state: unknown = window.history.state): AnalysisHistoryState | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[ANALYSIS_HISTORY_KEY];
  if (!value || typeof value !== "object") return null;
  const { source, depth } = value as Partial<AnalysisHistoryState>;
  return typeof source === "string" && source.startsWith("/") && Number.isInteger(depth) && (depth ?? 0) > 0
    ? { source, depth: depth! }
    : null;
}

export function analysisHistoryStateForNavigation(
  mode: "push" | "replace",
  href?: string,
): Record<string, unknown> {
  const current = readAnalysisHistoryState();
  if (!current) return {};
  if (href) {
    const parsed = parseGovernanceUrl(href);
    if (parsed.kind !== "route" || !isAnalysisRoute(parsed.route)) return {};
  }
  const state = window.history.state;
  const base = state && typeof state === "object" ? state : {};
  return {
    ...base,
    [ANALYSIS_HISTORY_KEY]: {
      source: current.source,
      depth: mode === "push" ? current.depth + 1 : current.depth,
    },
  };
}

export function markAnalysisHistoryEntry(source: string, depth: number): void {
  const state = window.history.state;
  const base = state && typeof state === "object" ? state : {};
  replaceAppHistoryState({ ...base, [ANALYSIS_HISTORY_KEY]: { source, depth } });
}

export function ensureAnalysisHistoryEntry(fallbackUrl: string): boolean {
  if (readAnalysisHistoryState()) return false;
  const currentUrl = `${window.location.pathname}${window.location.search}`;
  replaceAppHistoryState({}, fallbackUrl);
  pushAppHistoryState({}, currentUrl);
  markAnalysisHistoryEntry(fallbackUrl, 1);
  return true;
}

export function closeAnalysisHistory(fallback: () => void): void {
  const state = readAnalysisHistoryState();
  if (!state) {
    fallback();
    return;
  }
  window.history.go(-state.depth);
}
