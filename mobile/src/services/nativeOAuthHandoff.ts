import { authFetch } from '@agent/shared';
import { mobileSecureStorage } from '../platform/mobileSecureStorage';

const DEVICE_KEY = 'native-oauth-device-id-v1';
let deviceIdInitialization: Promise<string> | undefined;

async function initializeDeviceId(): Promise<string> {
  const existing = await mobileSecureStorage.getItem(DEVICE_KEY);
  if (existing) return existing;
  const randomUUID = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto?.randomUUID;
  if (!randomUUID) throw new Error('设备安全随机数能力不可用');
  const deviceId = `device-${randomUUID()}`;
  await mobileSecureStorage.setItem(DEVICE_KEY, deviceId);
  const persisted = await mobileSecureStorage.getItem(DEVICE_KEY);
  if (!persisted) throw new Error('OAuth 设备绑定 ID 未能安全持久化');
  return persisted;
}

export function getOrCreateNativeOAuthDeviceId(): Promise<string> {
  if (!deviceIdInitialization) {
    deviceIdInitialization = initializeDeviceId().catch(error => {
      deviceIdInitialization = undefined;
      throw error;
    });
  }
  return deviceIdInitialization;
}

export async function consumeNativeOAuthHandoff(code: string): Promise<{
  connectorId: string; status: 'succeeded' | 'failed'; errorCode?: string;
}> {
  const deviceId = await mobileSecureStorage.getItem(DEVICE_KEY);
  if (!deviceId) throw new Error('本机没有匹配的 OAuth 授权事务');
  const response = await authFetch('/api/connectors/oauth/native/handoff', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceId }),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'OAuth 安全回跳校验失败');
  if (typeof payload.connectorId !== 'string' || (payload.status !== 'succeeded' && payload.status !== 'failed')) {
    throw new Error('OAuth 回跳响应合同无效');
  }
  return {
    connectorId: payload.connectorId, status: payload.status,
    ...(typeof payload.errorCode === 'string' ? { errorCode: payload.errorCode } : {}),
  };
}
