interface SandboxLifecycleMetricsInput {
  createdAt?: string;
  lastActiveAt?: string;
  terminalAt?: string;
  deadlineAt?: string;
  nowMs: number;
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function sandboxLifecycleMetrics(input: SandboxLifecycleMetricsInput): {
  effectiveTtlMs?: number;
  ttlRemainingMs?: number;
} {
  const deadlineMs = timestamp(input.deadlineAt);
  const anchors = [input.createdAt, input.lastActiveAt, input.terminalAt]
    .map(timestamp)
    .filter((value): value is number => value !== undefined);
  const anchorMs = anchors.length > 0 ? Math.max(...anchors) : undefined;
  return {
    ...(deadlineMs === undefined || anchorMs === undefined ? {} : { effectiveTtlMs: Math.max(0, deadlineMs - anchorMs) }),
    ...(deadlineMs === undefined ? {} : { ttlRemainingMs: Math.max(0, deadlineMs - input.nowMs) }),
  };
}
