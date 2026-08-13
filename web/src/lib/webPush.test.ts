import { afterEach, describe, expect, it, vi } from 'vitest';

import { authFetch } from '@/lib/authFetch';
import {
  describeBrowserDevice,
  disableCurrentWebPush,
  enableWebPush,
  fetchWebPushStatus,
  getWebPushSupportReason,
} from './webPush';

vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));

const originalServiceWorker = navigator.serviceWorker;
const originalNotification = window.Notification;
const originalPushManager = window.PushManager;
const originalIsSecureContext = window.isSecureContext;

function defineWindowValue(key: 'Notification' | 'PushManager', value: unknown) {
  Object.defineProperty(window, key, { configurable: true, writable: true, value });
}

function defineServiceWorker(value: unknown) {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value });
}

function defineSecureContext(value: boolean | undefined) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
}

afterEach(() => {
  vi.restoreAllMocks();
  defineServiceWorker(originalServiceWorker);
  defineWindowValue('Notification', originalNotification);
  defineWindowValue('PushManager', originalPushManager);
  defineSecureContext(originalIsSecureContext);
  localStorage.removeItem('agent_saas_web_push_binding');
});

describe('Web Push 浏览器客户端', () => {
  it('读取服务端配置与当前账号的设备列表', async () => {
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({
      configured: true,
      publicKey: 'public',
      subscriptions: [{ id: 'sub-1', deviceName: 'Chrome · Windows', createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z' }],
    }), { status: 200 }));

    await expect(fetchWebPushStatus()).resolves.toMatchObject({ configured: true, publicKey: 'public' });
    expect(authFetch).toHaveBeenCalledWith('/api/web-push/status');
  });

  it('只在用户主动开启时申请授权、创建标准 PushSubscription 并保存', async () => {
    const unsubscribe = vi.fn();
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/device',
      unsubscribe,
      toJSON: () => ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/device',
        keys: { p256dh: 'p256dh', auth: 'auth' },
      }),
    } as unknown as PushSubscription;
    const subscribe = vi.fn().mockResolvedValue(subscription);
    defineSecureContext(true);
    defineServiceWorker({
      ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null), subscribe } }),
    });
    defineWindowValue('PushManager', class PushManager {});
    defineWindowValue('Notification', { permission: 'default', requestPermission: vi.fn().mockResolvedValue('granted') });
    vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ id: 'sub-1' }), { status: 201 }));

    await expect(enableWebPush('BEl6ZmFrZS1rZXk')).resolves.toBe(subscription);
    expect(window.Notification.requestPermission).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(authFetch).toHaveBeenCalledWith('/api/web-push/subscriptions', expect.objectContaining({ method: 'POST' }));
    const saveCall = vi.mocked(authFetch).mock.calls.find(([url]) => url === '/api/web-push/subscriptions');
    const body = JSON.parse(String(saveCall?.[1]?.body));
    expect(body).toMatchObject({
      endpoint: subscription.endpoint,
      keys: { p256dh: 'p256dh', auth: 'auth' },
    });
  });

  it('关闭当前设备时删除服务端记录并取消浏览器订阅', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const current = { endpoint: 'https://fcm.googleapis.com/device', unsubscribe } as unknown as PushSubscription;
    vi.mocked(authFetch).mockResolvedValue(new Response(null, { status: 204 }));
    localStorage.setItem('agent_saas_web_push_binding', JSON.stringify({ id: 'sub-1', endpoint: current.endpoint }));

    await disableCurrentWebPush({
      configured: true,
      publicKey: 'public',
      subscriptions: [{ id: 'sub-1', deviceName: 'Chrome · Windows', createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z' }],
    }, current);

    expect(authFetch).toHaveBeenCalledWith('/api/web-push/subscriptions/sub-1', { method: 'DELETE' });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('给出可诊断的不支持原因，并生成不含完整 UA 的设备名称', () => {
    defineSecureContext(true);
    defineServiceWorker({});
    defineWindowValue('Notification', originalNotification ?? class Notification {});
    Reflect.deleteProperty(window, 'PushManager');
    expect(getWebPushSupportReason()).toBe('push-manager');
    expect(describeBrowserDevice(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36',
      'Win32',
    )).toBe('Chrome · Windows');
  });
});
