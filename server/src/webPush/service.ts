import webPush from 'web-push';

import type { WebPushConfig } from '../app/config.js';
import { createLogger } from '../utils/logger.js';
import type { PushMessage, PushSendCounters, PushSender } from '../push/sender.js';
import { emptyPushCounters, normalizePushTargetUrl } from '../push/sender.js';
import type { WebPushOwner, WebPushSubscriptionInput, WebPushSubscriptionRecord } from './store.js';
import { PgWebPushStore } from './store.js';

const logger = createLogger('WebPush');
const ALLOWED_ENDPOINT_SUFFIXES = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
] as const;
// Chromium may return a regional jmtN.google.com endpoint instead of fcm.googleapis.com.
const CHROME_PUSH_HOST_PATTERN = /^jmt\d+\.google\.com$/;

export type WebPushMessage = PushMessage;

export interface WebPushPublicSubscription {
  id: string;
  deviceName: string;
  createdAt: string;
  updatedAt: string;
}

/** 同一订阅连续失败多少次后判定为死订阅并清理；死订阅不应被无限重投。 */
export const MAX_CONSECUTIVE_PUSH_FAILURES = 5;

export class WebPushService implements PushSender {
  readonly publicKey: string;
  /** subscriptionId → 连续失败次数；成功或清理后归零。进程内计数即可，死订阅会在几分钟内耗尽预算。 */
  private readonly consecutiveFailures = new Map<string, number>();

  constructor(
    private readonly store: PgWebPushStore,
    config: Required<Pick<WebPushConfig, 'publicKey' | 'privateKey' | 'subject'>>,
  ) {
    this.publicKey = config.publicKey;
    webPush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  }

  async list(owner: WebPushOwner): Promise<WebPushPublicSubscription[]> {
    return (await this.store.list(owner)).map(toPublicSubscription);
  }

  async subscribe(owner: WebPushOwner, input: WebPushSubscriptionInput): Promise<WebPushPublicSubscription> {
    assertSafePushEndpoint(input.endpoint);
    return toPublicSubscription(await this.store.save(owner, input));
  }

  async unsubscribe(owner: WebPushOwner, subscriptionId: string): Promise<boolean> {
    return await this.store.delete(owner, subscriptionId);
  }

  async send(message: WebPushMessage): Promise<PushSendCounters> {
    const subscriptions = await this.store.list(message);
    const counters = emptyPushCounters();

    await forEachConcurrent(subscriptions, 4, async (listedSubscription) => {
      const claim = await this.store.claimDelivery(message, listedSubscription, message.eventKey);
      if (!claim) {
        counters.skipped += 1;
        return;
      }
      if ('deferred' in claim) {
        counters.deferred += 1;
        return;
      }
      const subscription = claim.subscription;
      const payload = JSON.stringify({
        title: message.taskName.slice(0, 120),
        body: message.status.slice(0, 120),
        url: normalizePushTargetUrl(message.url),
        tag: message.eventKey.slice(0, 200),
      });

      try {
        await webPush.sendNotification({
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        }, payload, { TTL: 3600, urgency: 'normal', timeout: 10_000 });
        await claim.finish('sent');
        this.consecutiveFailures.delete(subscription.id);
        counters.sent += 1;
      } catch (error) {
        const statusCode = getStatusCode(error);
        const detail = describePushError(error);
        counters.failed += 1;
        const failureCount = (this.consecutiveFailures.get(subscription.id) ?? 0) + 1;
        this.consecutiveFailures.set(subscription.id, failureCount);
        let invalidated = false;
        try {
          if (statusCode === 404 || statusCode === 410) {
            await claim.invalidate();
            invalidated = true;
          } else {
            await claim.finish('failed', detail.slice(0, 500));
            // 推送服务不给状态码的失败（网络层错误、空响应）同样会耗尽订阅寿命：
            // 连续失败到上限即视为死订阅并清理，否则它会被按分钟无限重投。
            if (failureCount >= MAX_CONSECUTIVE_PUSH_FAILURES) {
              await this.store.delete(message, subscription.id);
              invalidated = true;
            }
          }
        } catch (storeError) {
          logger.warn(`推送失败后的订阅清理失败 subscription=${subscription.id}: ${String(storeError)}`);
        }
        if (invalidated) this.consecutiveFailures.delete(subscription.id);
        logger.warn(
          `浏览器通知发送失败 subscription=${subscription.id} status=${statusCode ?? 'unknown'}`
          + ` failures=${failureCount}${invalidated ? ' subscriptionRemoved=true' : ''}: ${detail}`,
        );
      }
    });

    return counters;
  }
}

export function isWebPushConfigured(config: WebPushConfig | undefined): config is WebPushConfig & {
  enabled: true;
  publicKey: string;
  privateKey: string;
  subject: string;
} {
  return config?.enabled === true && !!config.publicKey && !!config.privateKey && !!config.subject;
}

export function assertSafePushEndpoint(rawEndpoint: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(rawEndpoint);
  } catch {
    throw new Error('PushSubscription endpoint 无效');
  }
  if (endpoint.protocol !== 'https:') throw new Error('PushSubscription endpoint 必须使用 HTTPS');
  const hostname = endpoint.hostname.toLowerCase();
  const isKnownPushService = ALLOWED_ENDPOINT_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
  if (!isKnownPushService && !CHROME_PUSH_HOST_PATTERN.test(hostname)) {
    throw new Error('PushSubscription endpoint 不是受支持的浏览器推送服务');
  }
  return endpoint;
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as { statusCode?: unknown }).statusCode;
  return typeof value === 'number' ? value : undefined;
}

/** web-push 的错误常常 message 为空；退回到 name/code/body，避免只留下一句 "unknown"。 */
function describePushError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const candidate = error as { message?: unknown; name?: unknown; code?: unknown; body?: unknown };
  const parts = [
    typeof candidate.message === 'string' && candidate.message.trim() ? candidate.message.trim() : undefined,
    typeof candidate.code === 'string' && candidate.code ? `code=${candidate.code}` : undefined,
    typeof candidate.body === 'string' && candidate.body.trim() ? `body=${candidate.body.trim()}` : undefined,
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(' ');
  return typeof candidate.name === 'string' && candidate.name ? candidate.name : 'no error detail';
}

async function forEachConcurrent<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (item) await worker(item);
    }
  }));
}

function toPublicSubscription(record: WebPushSubscriptionRecord): WebPushPublicSubscription {
  return {
    id: record.id,
    deviceName: record.deviceName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
