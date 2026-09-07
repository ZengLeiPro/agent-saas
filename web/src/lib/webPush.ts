import { apiUrl } from '@/lib/apiBase';
import { authFetch } from '@/lib/authFetch';
import { TOKEN_KEY } from '@/lib/constants';
import { readTabScopedAuth } from "@/platform/tabScopedAuthStorage";

const LOCAL_BINDING_KEY = 'agent_saas_web_push_binding';
const SERVICE_WORKER_TIMEOUT_MS = 10_000;
const PUSH_SUBSCRIPTION_TIMEOUT_MS = 15_000;
const SAVE_SUBSCRIPTION_TIMEOUT_MS = 10_000;

export interface WebPushSubscriptionView {
  id: string;
  deviceName: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebPushStatus {
  configured: boolean;
  publicKey: string | null;
  subscriptions: WebPushSubscriptionView[];
}

export type WebPushSupportReason = 'supported' | 'insecure' | 'service-worker' | 'push-manager' | 'notification';

export function getWebPushSupportReason(): WebPushSupportReason {
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator)) return 'service-worker';
  if (!('PushManager' in window)) return 'push-manager';
  if (!('Notification' in window)) return 'notification';
  return 'supported';
}

export async function fetchWebPushStatus(): Promise<WebPushStatus> {
  const response = await authFetch('/api/web-push/status');
  if (!response.ok) throw new Error(await readError(response, '读取浏览器通知状态失败'));
  const body = await response.json() as Partial<WebPushStatus>;
  return {
    configured: body.configured === true,
    publicKey: typeof body.publicKey === 'string' ? body.publicKey : null,
    subscriptions: Array.isArray(body.subscriptions) ? body.subscriptions : [],
  };
}

export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (getWebPushSupportReason() !== 'supported') return null;
  const registration = await withTimeout(
    navigator.serviceWorker.getRegistration(),
    SERVICE_WORKER_TIMEOUT_MS,
    '读取 Service Worker 注册超时，请刷新页面后重试',
  );
  return registration
    ? withTimeout(
        registration.pushManager.getSubscription(),
        PUSH_SUBSCRIPTION_TIMEOUT_MS,
        '读取当前浏览器通知订阅超时，请刷新页面后重试',
      )
    : null;
}

export async function enableWebPush(publicKey: string): Promise<PushSubscription> {
  if (getWebPushSupportReason() !== 'supported') throw new Error('当前浏览器不支持 Web Push');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? '通知权限已被拒绝' : '尚未授予通知权限');

  const registration = await withTimeout(
    navigator.serviceWorker.ready,
    SERVICE_WORKER_TIMEOUT_MS,
    '等待 Service Worker 激活超时，请刷新页面后重试',
  );
  if (registration.update) {
    await withTimeout(
      registration.update(),
      SERVICE_WORKER_TIMEOUT_MS,
      '更新 Service Worker 超时，请刷新页面后重试',
    ).catch(() => undefined);
  }
  if (registration.waiting) {
    throw new Error('平台新版本已就绪，请先点击页面上的“立即更新”，刷新后再开启桌面通知');
  }

  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  let existing = await withTimeout(
    registration.pushManager.getSubscription(),
    PUSH_SUBSCRIPTION_TIMEOUT_MS,
    '读取当前浏览器通知订阅超时，请刷新页面后重试',
  );
  if (existing?.options.applicationServerKey && !sameBytes(existing.options.applicationServerKey, applicationServerKey)) {
    await withTimeout(existing.unsubscribe(), PUSH_SUBSCRIPTION_TIMEOUT_MS, '清理旧浏览器通知订阅超时').catch(() => undefined);
    existing = null;
  }
  const subscription = existing ?? await withTimeout(
    registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    }),
    PUSH_SUBSCRIPTION_TIMEOUT_MS,
    '创建浏览器通知订阅超时，请检查网络或浏览器通知设置后重试',
  );
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    await subscription.unsubscribe().catch(() => undefined);
    throw new Error('浏览器返回的 PushSubscription 不完整');
  }

  const response = await authFetchWithTimeout('/api/web-push/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      deviceName: describeBrowserDevice(),
    }),
  }, SAVE_SUBSCRIPTION_TIMEOUT_MS, '保存浏览器通知订阅超时，请检查网络后重试');
  if (!response.ok) throw new Error(await readError(response, '保存浏览器通知订阅失败'));
  const saved = await response.json() as { id?: unknown };
  if (typeof saved.id !== 'string' || !saved.id) throw new Error('服务端返回的订阅标识无效');
  writeLocalBinding({ id: saved.id, endpoint: subscription.endpoint });
  return subscription;
}

export async function removeWebPushSubscription(subscriptionId: string): Promise<void> {
  const response = await authFetch(`/api/web-push/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(await readError(response, '关闭浏览器通知失败'));
  if (readLocalBinding()?.id === subscriptionId) writeLocalBinding(null);
}

export function getCurrentWebPushRecord(
  status: WebPushStatus,
  current: PushSubscription | null,
): WebPushSubscriptionView | undefined {
  const binding = readLocalBinding();
  if (!current || !binding || binding.endpoint !== current.endpoint) return undefined;
  return status.subscriptions.find((item) => item.id === binding.id);
}

export async function unsubscribeCurrentBrowserPush(): Promise<void> {
  const binding = readLocalBinding();
  const token = readTabScopedAuth(TOKEN_KEY);
  writeLocalBinding(null);

  // 先发起服务端删除，不让 Service Worker API 异常阻塞旧账号解绑；也不走全局 401 回调。
  if (binding?.id && token) {
    void fetch(apiUrl(`/api/web-push/subscriptions/${encodeURIComponent(binding.id)}`), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      keepalive: true,
    }).catch(() => undefined);
  }

  if (getWebPushSupportReason() !== 'supported') return;
  try {
    const registration = await withTimeout(navigator.serviceWorker.getRegistration(), 1_500);
    const subscription = await withTimeout(registration?.pushManager.getSubscription() ?? Promise.resolve(null), 1_500);
    if (subscription) await withTimeout(subscription.unsubscribe(), 1_500);
  } catch {
    // 退出和切号必须继续；服务端记录已异步删除，后续失效订阅还有 404/410 清理兜底。
  }
}

export async function disableCurrentWebPush(
  status: WebPushStatus,
  current: PushSubscription | null,
): Promise<void> {
  const record = getCurrentWebPushRecord(status, current);
  if (record) await removeWebPushSubscription(record.id);
  await current?.unsubscribe().catch(() => undefined);
  writeLocalBinding(null);
}

export function describeBrowserDevice(userAgent = navigator.userAgent, platform = navigator.platform): string {
  const browser = /Edg\//.test(userAgent)
    ? 'Microsoft Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Safari\//.test(userAgent)
        ? 'Safari'
        : '浏览器';
  const os = /Windows/i.test(userAgent) ? 'Windows' : /Mac/i.test(platform) ? 'macOS' : '其他系统';
  return `${browser} · ${os}`;
}

function sameBytes(left: ArrayBuffer, right: Uint8Array<ArrayBuffer>): boolean {
  const leftBytes = new Uint8Array(left);
  if (leftBytes.length !== right.length) return false;
  return leftBytes.every((value, index) => value === right[index]);
}

function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - value.length % 4) % 4);
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message = 'Web Push 操作超时'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function authFetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
  message: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await authFetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(message);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function readLocalBinding(): { id: string; endpoint: string } | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LOCAL_BINDING_KEY) ?? 'null') as { id?: unknown; endpoint?: unknown } | null;
    return parsed && typeof parsed.id === 'string' && typeof parsed.endpoint === 'string'
      ? { id: parsed.id, endpoint: parsed.endpoint }
      : null;
  } catch {
    return null;
  }
}

function writeLocalBinding(binding: { id: string; endpoint: string } | null): void {
  if (binding) localStorage.setItem(LOCAL_BINDING_KEY, JSON.stringify(binding));
  else localStorage.removeItem(LOCAL_BINDING_KEY);
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}
