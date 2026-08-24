export function redactDurableSecrets(value: string): string {
  return value
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(token|password)\s*=\s*[^\s&;"']+/gi, (_match, name: string) => `${name}=[REDACTED]`)
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function redactDurableJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => (
    typeof item === 'string' ? redactDurableSecrets(item).slice(0, 8_192) : item
  ))) as T;
}
