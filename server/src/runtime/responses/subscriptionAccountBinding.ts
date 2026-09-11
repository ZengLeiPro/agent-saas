import { createHash } from 'node:crypto';
export function hashAccountBinding(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 32);
}
export function orderedCredentialRefs(
  config: { credentialRef?: string; credentialRefs?: string[] } | undefined,
): string[] {
  const refs = config?.credentialRefs?.length
    ? config.credentialRefs
    : config?.credentialRef
      ? [config.credentialRef]
      : [];
  return [...new Set(refs.filter((ref) => typeof ref === 'string' && ref.trim().length > 0))];
}
