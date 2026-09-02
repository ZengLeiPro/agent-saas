import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-local-authentication', () => ({}));

import { createBiometricLocalAuth } from './biometricLocalAuth';

function native(overrides: Record<string, unknown> = {}) {
  return {
    hasHardwareAsync: vi.fn().mockResolvedValue(true),
    isEnrolledAsync: vi.fn().mockResolvedValue(true),
    supportedAuthenticationTypesAsync: vi.fn().mockResolvedValue([1]),
    authenticateAsync: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  } as any;
}

describe('M30-02 biometric native adapter', () => {
  it.each([
    [false, true, [1], { supported: false, enrolled: true }],
    [true, false, [1], { supported: true, enrolled: false }],
    [true, true, [], { supported: false, enrolled: true }],
  ])('fails closed for hardware/enrollment combinations', async (hardware, enrolled, types, expected) => {
    const adapter = createBiometricLocalAuth(native({
      hasHardwareAsync: vi.fn().mockResolvedValue(hardware),
      isEnrolledAsync: vi.fn().mockResolvedValue(enrolled),
      supportedAuthenticationTypesAsync: vi.fn().mockResolvedValue(types),
    }));
    await expect(adapter.availability()).resolves.toEqual(expected);
  });

  it('enables device credential fallback and maps success', async () => {
    const impl = native();
    const adapter = createBiometricLocalAuth(impl);
    await expect(adapter.authenticate()).resolves.toEqual({ ok: true });
    expect(impl.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ disableDeviceFallback: false }));
  });

  it.each([
    ['user_cancel', 'cancelled'],
    ['system_cancel', 'cancelled'],
    ['lockout', 'lockout'],
    ['authentication_failed', 'failed'],
  ])('maps %s without automatic retry', async (error, reason) => {
    const impl = native({ authenticateAsync: vi.fn().mockResolvedValue({ success: false, error }) });
    const adapter = createBiometricLocalAuth(impl);
    await expect(adapter.authenticate()).resolves.toEqual({ ok: false, reason });
    expect(impl.authenticateAsync).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent prompts', async () => {
    let resolve!: (value: { success: boolean }) => void;
    const impl = native({ authenticateAsync: vi.fn(() => new Promise((r) => { resolve = r; })) });
    const adapter = createBiometricLocalAuth(impl);
    const first = adapter.authenticate();
    const second = adapter.authenticate();
    expect(first).toBe(second);
    resolve({ success: true });
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(impl.authenticateAsync).toHaveBeenCalledTimes(1);
  });
});
