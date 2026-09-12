import type { GrokDeviceSession, GrokSubscriptionState } from './subscriptionTypes';
export const GROK_ADMIN_API = '/api/admin/grok-subscription';
export async function readSubscriptionJson<T>(
  response: Response,
): Promise<T & { error?: string; code?: string }> {
  return (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
}
export function safeGrokVerificationUri(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['auth.x.ai', 'accounts.x.ai', 'x.ai'].includes(url.hostname) &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.hash
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function validGrokSession(session: GrokDeviceSession): boolean {
  return (
    typeof session.sessionId === 'string' &&
    /^[A-Za-z0-9-]{1,128}$/.test(session.sessionId) &&
    Number.isFinite(Date.parse(session.expiresAt)) &&
    session.status === 'pending' &&
    typeof session.userCode === 'string' &&
    session.userCode.length > 0 &&
    session.userCode.length <= 128 &&
    !!safeGrokVerificationUri(session.verificationUri)
  );
}
export function grokPollInterval(
  session: Pick<GrokDeviceSession, 'intervalMs' | 'intervalSeconds'>,
): number {
  const value = session.intervalMs ?? (session.intervalSeconds ?? 5) * 1000;
  return Number.isFinite(value) ? Math.max(1000, Math.min(300_000, value)) : 5000;
}
export function validGrokState(
  value: GrokSubscriptionState | undefined,
): value is GrokSubscriptionState {
  return (
    !!value?.config && Array.isArray(value.credentials) && typeof value.config.enabled === 'boolean'
  );
}
