import { createHash } from 'node:crypto';
/** Reserve space for constraint/index suffixes; never rely on PostgreSQL's silent truncation. */
export function grokSubscriptionTableName(
  prefix: string,
  kind: 'runtime_state' | 'refresh_journal',
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new Error('Invalid runtime table prefix');
  const suffix =
    kind === 'runtime_state'
      ? '_grok_credential_runtime_state'
      : '_grok_credential_refresh_journal';
  const budget = 44 - suffix.length;
  const safePrefix =
    prefix.length <= budget
      ? prefix
      : `g${createHash('sha256')
          .update(prefix)
          .digest('hex')
          .slice(0, budget - 1)}`;
  return `${safePrefix}${suffix}`;
}
