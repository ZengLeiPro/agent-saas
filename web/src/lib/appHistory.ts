const APP_HISTORY_INDEX_KEY = "__appHistoryIndex";

export function readAppHistoryIndex(state: unknown = window.history.state): number | null {
  if (!state || typeof state !== "object") return null;
  const index = (state as Record<string, unknown>)[APP_HISTORY_INDEX_KEY];
  return typeof index === "number" && Number.isInteger(index) ? index : null;
}

export function ensureAppHistoryIndex(): number {
  const current = readAppHistoryIndex();
  if (current !== null) return current;
  const state = window.history.state;
  const indexedState = state && typeof state === "object" ? structuredClone(state) as Record<string, unknown> : {};
  indexedState[APP_HISTORY_INDEX_KEY] = 0;
  window.history.replaceState(indexedState, "");
  return 0;
}

function indexedHistoryState(state: Record<string, unknown>, mode: "push" | "replace"): Record<string, unknown> {
  const current = readAppHistoryIndex();
  const index = mode === "push" ? (current ?? 0) + 1 : current ?? 0;
  return { ...state, [APP_HISTORY_INDEX_KEY]: index };
}

export function pushAppHistoryState(state: Record<string, unknown>, url: string): void {
  window.history.pushState(indexedHistoryState(state, "push"), "", url);
}

export function pushCurrentAppHistoryState(state: Record<string, unknown>, url: string): void {
  const current = window.history.state;
  pushAppHistoryState({ ...(current && typeof current === "object" ? current : {}), ...state }, url);
}

export function replaceAppHistoryState(state: Record<string, unknown>, url = ""): void {
  const current = window.history.state;
  window.history.replaceState(indexedHistoryState({ ...(current && typeof current === "object" ? current : {}), ...state }, "replace"), "", url);
}

export function replaceAppHistoryUrl(url: string): void {
  const state = window.history.state;
  replaceAppHistoryState(state && typeof state === "object" ? state : {}, url);
}
