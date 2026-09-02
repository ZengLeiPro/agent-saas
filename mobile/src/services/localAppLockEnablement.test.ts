import { describe, expect, it, vi } from 'vitest';
import { enableLocalAppLock, type LocalLockSessionValidation } from './localAppLockEnablement';

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    validateSession: vi.fn<() => Promise<LocalLockSessionValidation>>().mockResolvedValue('valid'),
    availability: vi.fn().mockResolvedValue({ supported: true, enrolled: true }),
    authenticate: vi.fn().mockResolvedValue({ ok: true }),
    persist: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

describe('M30-02 enablement transaction', () => {
  it.each(['invalid', 'offline'] as const)('requires a current online server session: %s', async (validation) => {
    const deps = dependencies({ validateSession: vi.fn().mockResolvedValue(validation) });
    expect((await enableLocalAppLock(deps)).ok).toBe(false);
    expect(deps.authenticate).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it.each([
    [{ supported: false, enrolled: false }, '不支持'],
    [{ supported: true, enrolled: false }, '录入'],
  ])('fails closed for unavailable capability', async (availability, message) => {
    const deps = dependencies({ availability: vi.fn().mockResolvedValue(availability) });
    const result = await enableLocalAppLock(deps);
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain(message);
    expect(deps.authenticate).not.toHaveBeenCalled();
  });

  it('does not persist after local authentication failure', async () => {
    const deps = dependencies({ authenticate: vi.fn().mockResolvedValue({ ok: false, reason: 'lockout' }) });
    expect((await enableLocalAppLock(deps)).ok).toBe(false);
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it('persists only after server, capability, enrollment, and local authentication succeed', async () => {
    const deps = dependencies();
    await expect(enableLocalAppLock(deps)).resolves.toMatchObject({ ok: true });
    expect(deps.persist).toHaveBeenCalledTimes(1);
  });
});
