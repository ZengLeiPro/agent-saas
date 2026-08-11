import { describe, expect, it, vi } from 'vitest';

import {
  NativeOAuthHandoffStore,
  type NativeOAuthHandoffPersistence,
} from '../connectors/nativeOAuthHandoff.js';

function persistence(): NativeOAuthHandoffPersistence {
  return {
    beginNativeHandoff: vi.fn().mockResolvedValue(undefined),
    completeNativeHandoff: vi.fn().mockResolvedValue('a'.repeat(48)),
    consumeNativeHandoff: vi.fn().mockResolvedValue({ connectorId: 'google-workspace', status: 'succeeded' }),
  };
}

describe('原生 App OAuth 安全回跳', () => {
  it('只接受固定 HTTPS App Link，拒绝任意 scheme、query 与凭据', () => {
    const authority = persistence();
    expect(() => new NativeOAuthHandoffStore(authority, 'kaiyan://oauth/callback')).toThrow('fixed HTTPS');
    expect(() => new NativeOAuthHandoffStore(authority, 'https://app.example.com/oauth/callback?next=evil')).toThrow('fixed HTTPS');
    expect(() => new NativeOAuthHandoffStore(authority, 'https://user@app.example.com/oauth/callback')).toThrow('fixed HTTPS');
  });

  it('绑定 user/tenant/connector/device，回跳 URL 只携带短码', async () => {
    const authority = persistence();
    const store = new NativeOAuthHandoffStore(authority, 'https://app.example.com/app/oauth/callback');
    await store.begin({
      providerState: 'state-12345678', userId: 'user-1', tenantId: 'tenant-a',
      connectorId: 'google-workspace', deviceId: 'device-1234',
    });
    const redirect = await store.complete('state-12345678', { status: 'succeeded' });
    expect(redirect).toBe(`https://app.example.com/app/oauth/callback?code=${'a'.repeat(48)}`);
    expect(redirect).not.toMatch(/user-1|tenant-a|google-workspace|device-1234/);
    await store.consume({ code: 'a'.repeat(48), userId: 'user-1', tenantId: 'tenant-a', deviceId: 'device-1234' });
    expect(authority.beginNativeHandoff).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device-1234' }));
    expect(authority.consumeNativeHandoff).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user-1', tenantId: 'tenant-a' }));
  });

  it('拒绝不稳定或可注入的 deviceId', async () => {
    const store = new NativeOAuthHandoffStore(persistence(), 'https://app.example.com/app/oauth/callback');
    await expect(store.begin({
      providerState: 'state-12345678', userId: 'user-1', tenantId: 'tenant-a', connectorId: 'mcp-1', deviceId: '../bad',
    })).rejects.toThrow('deviceId');
  });
});
