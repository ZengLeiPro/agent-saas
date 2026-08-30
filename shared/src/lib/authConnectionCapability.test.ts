import { describe, expect, it } from 'vitest';
import {
  evaluateCapability, isSensitiveCapabilityAllowed, presentCapability,
  reduceCapabilityStatus, unknownServerCapability, type CapabilityObservation,
} from './authConnectionCapability';

const base: CapabilityObservation = {
  userId: 'u1', tenantId: 't1', provider: 'google-workspace', channel: 'mobile',
  correlationId: 'corr-12345678', observedAt: '2026-08-30T00:00:00.000Z',
  providerConfigured: true, callbackDomainConfigured: true, ssoAvailable: true,
  credential: 'valid', network: 'online', server: 'healthy', tenantAllowed: true,
  operation: 'connection',
};
const evaluate = (patch: Partial<CapabilityObservation> = {}) => evaluateCapability({ ...base, ...patch });

describe('M30-03 capability state machine', () => {
  it('returns authoritative normal only when all checks pass', () => {
    const state = evaluate();
    expect(state).toMatchObject({ mode: 'normal', reasonCode: 'none', authoritative: true, requiresServerRevalidation: false });
    expect(isSensitiveCapabilityAllowed(state)).toBe(true);
  });
  it('distinguishes provider not configured', () => expect(evaluate({ providerConfigured: false })).toMatchObject({ mode: 'blocked', reasonCode: 'provider_not_configured', allowedActions: ['contact_admin'] }));
  it('distinguishes callback domain missing with explicit browser action', () => expect(evaluate({ callbackDomainConfigured: false })).toMatchObject({ mode: 'degraded', reasonCode: 'callback_domain_missing', allowedActions: ['use_system_browser_sso', 'contact_admin'] }));
  it('does not require native callback on web', () => expect(evaluate({ channel: 'web', callbackDomainConfigured: false })).toMatchObject({ mode: 'normal' }));
  it('distinguishes SSO unavailable', () => expect(evaluate({ operation: 'auth', ssoAvailable: false })).toMatchObject({ mode: 'blocked', reasonCode: 'sso_unavailable' }));
  it('distinguishes expired credential and blocks send/refresh', () => expect(evaluate({ credential: 'expired' })).toMatchObject({ mode: 'degraded', reasonCode: 'credential_expired', affectedCapabilities: ['connection.refresh', 'messaging.send'] }));
  it('limits offline mode to retry and readonly shell', () => expect(evaluate({ network: 'offline' })).toMatchObject({ mode: 'degraded', reasonCode: 'network_offline', allowedActions: ['open_readonly_local_shell', 'retry_later'] }));
  it('distinguishes server degraded', () => expect(evaluate({ server: 'degraded' })).toMatchObject({ mode: 'degraded', reasonCode: 'server_degraded' }));
  it('tenant policy wins over all fallback', () => expect(evaluate({ tenantAllowed: false, server: 'degraded', providerConfigured: false })).toMatchObject({ mode: 'blocked', reasonCode: 'tenant_policy_disabled', allowedActions: ['contact_admin'] }));
  it('client offline cannot become authoritative', () => expect(reduceCapabilityStatus(evaluate(), { type: 'client_offline', observedAt: 'later', correlationId: 'offline-1' })).toMatchObject({ mode: 'degraded', authoritative: false, requiresServerRevalidation: true }));
  it('user cancellation blocks and requires revalidation', () => expect(reduceCapabilityStatus(evaluate(), { type: 'user_cancelled', observedAt: 'later', correlationId: 'cancel-1' })).toMatchObject({ mode: 'blocked', reasonCode: 'user_cancelled', requiresServerRevalidation: true }));
  it('recovery request cannot optimistically restore normal', () => expect(reduceCapabilityStatus(evaluate({ credential: 'expired' }), { type: 'recovery_requested' })).toMatchObject({ mode: 'blocked', allowedActions: [], requiresServerRevalidation: true }));
  it('authoritative hydrate is the only route back to normal', () => {
    const degraded = reduceCapabilityStatus(evaluate(), { type: 'client_offline', observedAt: 'later', correlationId: 'offline-1' });
    expect(reduceCapabilityStatus(degraded, { type: 'hydrate_authoritative', status: evaluate() })).toMatchObject({ mode: 'normal', authoritative: true });
  });
  it('ignores non-authoritative hydrate', () => {
    const normal = evaluate();
    const local = reduceCapabilityStatus(normal, { type: 'client_offline', observedAt: 'later', correlationId: 'offline-1' })!;
    expect(reduceCapabilityStatus(normal, { type: 'hydrate_authoritative', status: local })).toBe(normal);
  });
  it('N-1 is blocked by default', () => expect(unknownServerCapability({ userId: 'u', tenantId: 't', provider: 'p', channel: 'mobile', observedAt: 'now', correlationId: 'c' })).toMatchObject({ mode: 'blocked', reasonCode: 'unknown_server_capability', allowedActions: [] }));
  it('N-1 permits only explicit browser flow', () => expect(unknownServerCapability({ userId: 'u', tenantId: 't', provider: 'p', channel: 'mobile', observedAt: 'now', correlationId: 'c', explicitBrowserFlow: true }).allowedActions).toEqual(['use_system_browser_sso']));
  it('presentation marks browser action as leaving app', () => expect(presentCapability(evaluate({ callbackDomainConfigured: false })).actions[0]).toMatchObject({ action: 'use_system_browser_sso', leavesApp: true }));
  it('never exposes forbidden fallback actions', () => {
    const serialized = JSON.stringify(evaluate({ providerConfigured: false }));
    expect(serialized).not.toMatch(/token|http_callback|bypass/i);
  });
});
