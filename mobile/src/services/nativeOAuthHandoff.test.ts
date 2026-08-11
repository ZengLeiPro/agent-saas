import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn() }));
vi.mock('../platform/mobileSecureStorage', () => ({ mobileSecureStorage: storage }));

async function loadService() {
  vi.resetModules();
  return import('./nativeOAuthHandoff');
}

beforeEach(() => {
  storage.getItem.mockReset();
  storage.setItem.mockReset();
  vi.restoreAllMocks();
});

describe('native OAuth device ID single-flight', () => {
  it('100 路首次并发只生成和写入一次，并返回同一持久 ID', async () => {
    storage.getItem.mockResolvedValueOnce(null).mockResolvedValue('device-fixed');
    storage.setItem.mockResolvedValue(undefined);
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('uuid-fixed' as `${string}-${string}-${string}-${string}-${string}`);
    const service = await loadService();

    const values = await Promise.all(Array.from({ length: 100 }, () => service.getOrCreateNativeOAuthDeviceId()));
    expect(new Set(values)).toEqual(new Set(['device-fixed']));
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith('native-oauth-device-id-v1', 'device-uuid-fixed');
  });

  it('已有 ID 时不生成也不写入', async () => {
    storage.getItem.mockResolvedValue('device-existing');
    const randomUUID = vi.spyOn(globalThis.crypto, 'randomUUID');
    const service = await loadService();
    await expect(service.getOrCreateNativeOAuthDeviceId()).resolves.toBe('device-existing');
    expect(randomUUID).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('首次写失败后清除 single-flight，下一次可以重试', async () => {
    storage.getItem.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue('device-retried');
    storage.setItem.mockRejectedValueOnce(new Error('secure storage unavailable')).mockResolvedValueOnce(undefined);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('uuid-retry' as `${string}-${string}-${string}-${string}-${string}`);
    const service = await loadService();
    await expect(service.getOrCreateNativeOAuthDeviceId()).rejects.toThrow('secure storage unavailable');
    await expect(service.getOrCreateNativeOAuthDeviceId()).resolves.toBe('device-retried');
    expect(storage.setItem).toHaveBeenCalledTimes(2);
  });

  it('写后复读为空时 fail closed', async () => {
    storage.getItem.mockResolvedValue(null);
    storage.setItem.mockResolvedValue(undefined);
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('uuid-empty' as `${string}-${string}-${string}-${string}-${string}`);
    const service = await loadService();
    await expect(service.getOrCreateNativeOAuthDeviceId()).rejects.toThrow('未能安全持久化');
  });
});
