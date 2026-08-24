export function limitComment(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 20_000) return normalized;
  return `${normalized.slice(0, 19_950)}\n\n[回执内容过长，已截断]`;
}

export function limitError(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 2_000 ? normalized : `${normalized.slice(0, 1_980)}…`;
}

export function dispatchRetryDelayMs(attemptCount: number): number {
  return Math.min(60_000, 1_000 * (2 ** Math.min(Math.max(attemptCount - 1, 0), 6)));
}
