import { authFetch } from './authFetch';
import { unknownServerCapability, type AuthConnectionCapabilityStatus, type CapabilityChannel } from './authConnectionCapability';

function validStatus(value: unknown): value is AuthConnectionCapabilityStatus {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<AuthConnectionCapabilityStatus>;
  return state.schemaVersion === 1 && ['normal', 'degraded', 'blocked'].includes(state.mode ?? '')
    && typeof state.reasonCode === 'string' && Array.isArray(state.affectedCapabilities)
    && Array.isArray(state.allowedActions) && Array.isArray(state.recoveryActions)
    && typeof state.observedAt === 'string' && typeof state.correlationId === 'string'
    && state.authoritative === true && !!state.subject;
}

/** Always hydrates from authority. A missing N-1 endpoint fails closed. */
export async function fetchAuthConnectionCapability(input: {
  userId: string; tenantId: string; provider: string; channel: CapabilityChannel;
  operation: 'auth' | 'connection'; explicitBrowserFlow?: boolean;
}): Promise<AuthConnectionCapabilityStatus> {
  const fallback = () => unknownServerCapability({
    userId: input.userId, tenantId: input.tenantId, provider: input.provider, channel: input.channel,
    observedAt: new Date().toISOString(), correlationId: `client-${Date.now()}`,
    explicitBrowserFlow: input.explicitBrowserFlow,
  });
  try {
    const query = new URLSearchParams({ provider: input.provider, channel: input.channel, operation: input.operation });
    const response = await authFetch(`/api/auth/capabilities/status?${query}`);
    if (!response.ok) return fallback();
    const body: unknown = await response.json();
    return validStatus(body) ? body : fallback();
  } catch {
    return fallback();
  }
}
