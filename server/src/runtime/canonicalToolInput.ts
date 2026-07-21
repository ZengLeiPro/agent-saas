import { createHash } from 'node:crypto';

/** 对已经 parse 的工具输入做键序稳定的 SHA-256 摘要。 */
export function canonicalToolInputDigest(input: unknown): string {
  return createHash('sha256').update(stableStringifyToolInput(input)).digest('hex');
}

function stableStringifyToolInput(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? 'null' : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyToolInput(item ?? null)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringifyToolInput(record[key])}`)
    .join(',')}}`;
}
