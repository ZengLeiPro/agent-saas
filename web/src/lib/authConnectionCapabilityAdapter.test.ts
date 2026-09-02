import { describe, expect, it, vi } from 'vitest';
import { evaluateCapability } from '@agent/shared';
import { runWebRecoveryAction } from './authConnectionCapabilityAdapter';
const state = evaluateCapability({ userId: 'u', tenantId: 't', provider: 'p', channel: 'web', correlationId: 'c', observedAt: 'now', providerConfigured: true, callbackDomainConfigured: false, ssoAvailable: true, credential: 'valid', network: 'online', server: 'healthy', tenantAllowed: true, operation: 'connection' });
const browserState = { ...state, mode: 'degraded' as const, allowedActions: ['use_system_browser_sso' as const] };
describe('web capability adapter', () => {
  it('does not open browser when user cancels explicit prompt', async () => { const open = vi.fn(); await runWebRecoveryAction({ action: 'use_system_browser_sso', status: browserState, confirmLeavingApp: async () => false, openSystemBrowser: open, revalidate: async () => state }); expect(open).not.toHaveBeenCalled(); });
  it('opens browser only after confirmation', async () => { const open = vi.fn(); await runWebRecoveryAction({ action: 'use_system_browser_sso', status: browserState, confirmLeavingApp: async () => true, openSystemBrowser: open, revalidate: async () => state }); expect(open).toHaveBeenCalledOnce(); });
  it('recovery returns revalidated authority', async () => { const expired = { ...state, mode: 'degraded' as const, allowedActions: ['reauthenticate' as const] }; await expect(runWebRecoveryAction({ action: 'reauthenticate', status: expired, confirmLeavingApp: async () => true, openSystemBrowser: vi.fn(), revalidate: async () => state })).resolves.toBe(state); });
  it('rejects non-authorized fallback', async () => { await expect(runWebRecoveryAction({ action: 'contact_admin', status: state, confirmLeavingApp: async () => true, openSystemBrowser: vi.fn(), revalidate: async () => state })).rejects.toThrow('not allowed'); });
});
