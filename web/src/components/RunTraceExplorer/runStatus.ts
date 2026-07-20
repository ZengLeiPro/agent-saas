export function isRunFailureStatus(status: string): boolean {
  return status === "failed" || status === "orphaned";
}

export function resolveRunFailureReason(
  status: string,
  statusReason: string | null | undefined,
  runFinishedError?: string,
): string | null {
  if (!isRunFailureStatus(status)) return null;
  return statusReason ?? runFinishedError ?? null;
}

export function resolveRunCancellationReason(
  status: string,
  statusReason: string | null | undefined,
): string | null {
  return status === "cancelled" ? statusReason ?? null : null;
}
