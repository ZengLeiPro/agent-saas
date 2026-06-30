/**
 * Shared plaintext-secret heuristics used by MCP server configuration validation
 * and tenant remote hand `authTokenRef` schema validation. Kept tiny and pattern-
 * based; not a substitute for proper secret review at the config-source layer.
 */

export function isSensitiveMcpKey(key: string): boolean {
  return /(^authorization$|token|api.?key|secret|password)/i.test(key);
}

export function looksLikeSecret(value: string): boolean {
  return /(bearer\s+[a-z0-9._-]{12,}|gh[pousr]_[a-z0-9_]+|github_pat_[a-z0-9_]+|sk-[a-z0-9_-]{12,})/i.test(value);
}

export function rejectPlaintextSecretMap(value: Record<string, string> | undefined, label: string): void {
  for (const [key, raw] of Object.entries(value ?? {})) {
    if (isSensitiveMcpKey(key) || looksLikeSecret(raw)) {
      throw new Error(`${label}.${key} appears to contain a plaintext secret; use envSecretRefs/headerSecretRefs`);
    }
  }
}
