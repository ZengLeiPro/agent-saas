import type { RunStatus } from '../runStore.js';

export function snapshotNumber(value: Record<string, unknown>, key: string): number | undefined {
  const raw = value[key];
  return typeof raw === 'number' && Number.isSafeInteger(raw) ? raw : undefined;
}

export function snapshotStrings(value: Record<string, unknown>, key: string): string[] {
  const candidate = value[key];
  if (
    !Array.isArray(candidate) ||
    candidate.some((item) => typeof item !== 'string' || !item.trim())
  )
    return [];
  const result = candidate.map((item) => (item as string).trim());
  return new Set(result).size === result.length ? result : [];
}

export function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

export function isRunTerminal(status: RunStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'orphaned'
  );
}

export function isWorkTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
