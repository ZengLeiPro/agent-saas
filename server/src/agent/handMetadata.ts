export function resolveRemoteHandAuthToken(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.serverRemoteAuthToken ?? metadata.authToken;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function resolveRemoteHandInvokeTimeoutMs(metadata: Record<string, unknown>): number | undefined {
  const value = metadata.invokeTimeoutMs ?? metadata.serverRemoteInvokeTimeoutMs;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
