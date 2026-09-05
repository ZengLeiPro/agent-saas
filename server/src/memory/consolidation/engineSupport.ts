import type { MemoryConsolidationEngineOptions } from './engine.js';

export async function readHiddenRunUsage(
  eventStore: MemoryConsolidationEngineOptions['eventStore'],
  tenantId: string,
  hiddenSessionId: string,
): Promise<{
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  modelActual?: string;
}> {
  const rows = await eventStore
    .listSessionRange(tenantId, hiddenSessionId, {
      fromExclusive: 0,
      toInclusive: Number.MAX_SAFE_INTEGER,
      limit: 2_000,
    })
    .catch(() => []);
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let modelActual: string | undefined;
  for (const { event } of rows) {
    if (event.type !== 'assistant_message' && event.type !== 'assistant_tool_calls') continue;
    const usage = event.usage;
    if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
      const values = usage as Record<string, unknown>;
      inputTokens += numberOrZero(values.inputTokens);
      outputTokens += numberOrZero(values.outputTokens);
      cacheReadTokens += numberOrZero(values.cacheReadInputTokens);
    }
    if (typeof event.model === 'string') modelActual = event.model;
  }
  return { inputTokens, outputTokens, cacheReadTokens, ...(modelActual ? { modelActual } : {}) };
}

export function parseTombstoneSnapshot(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) return null;
  const sorted = [...value].sort();
  return new Set(sorted).size === sorted.length ? sorted : null;
}

export function sameTombstoneSnapshot(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return left.every((id, index) => id === sortedRight[index]);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
