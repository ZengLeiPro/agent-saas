import type { ApnsConfig } from '../app/config.js';
import type { ApnsEnvironment } from '../app/pushConfigSchema.js';
import { APNS_ENVIRONMENTS } from '../app/pushConfigSchema.js';
import type { PushMessage, PushOwner, PushSendCounters, PushSender } from '../push/sender.js';
import { emptyPushCounters, normalizePushTargetUrl } from '../push/sender.js';
import { createLogger } from '../utils/logger.js';
import type { ApnsPushClient } from './client.js';
import type { ApnsDeviceRecord } from './store.js';
import { PgApnsDeviceStore } from './store.js';

const logger = createLogger('APNs');
/** APNs 设备令牌是 hex 串（当前 32 字节 = 64 字符，Apple 未承诺定长）。 */
const DEVICE_TOKEN_PATTERN = /^[0-9a-f]{32,400}$/i;
/** 这些 reason 表示令牌对本 App 永久无效，直接解绑；其它错误保留记录等下次事件重试。 */
const INVALID_TOKEN_REASONS = new Set([
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
  'Unregistered',
  'ExpiredToken',
]);

export interface ApnsDeviceRegistration {
  token: string;
  deviceName: string;
  environment?: ApnsEnvironment;
  appVersion?: string;
}

export interface ApnsPublicDevice {
  id: string;
  deviceName: string;
  environment: ApnsEnvironment;
  appVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApnsServiceOptions {
  /** 设备注册未声明环境时使用的默认环境。 */
  defaultEnvironment: ApnsEnvironment;
  clientFor: (environment: ApnsEnvironment) => ApnsPushClient;
}

export class ApnsService implements PushSender {
  constructor(
    private readonly store: PgApnsDeviceStore,
    private readonly options: ApnsServiceOptions,
  ) {}

  async list(owner: PushOwner): Promise<ApnsPublicDevice[]> {
    return (await this.store.list(owner)).map(toPublicDevice);
  }

  async register(owner: PushOwner, input: ApnsDeviceRegistration): Promise<ApnsPublicDevice> {
    const token = normalizeDeviceToken(input.token);
    const environment = input.environment ?? this.options.defaultEnvironment;
    if (!APNS_ENVIRONMENTS.includes(environment)) throw new Error('APNs environment 无效');
    return toPublicDevice(
      await this.store.save(owner, {
        token,
        environment,
        deviceName: input.deviceName,
        appVersion: input.appVersion,
      }),
    );
  }

  async unregister(owner: PushOwner, deviceId: string): Promise<boolean> {
    return await this.store.delete(owner, deviceId);
  }

  async send(message: PushMessage): Promise<PushSendCounters> {
    const devices = await this.store.list(message);
    const counters = emptyPushCounters();

    await forEachConcurrent(devices, 4, async (listed) => {
      const claim = await this.store.claimDelivery(message, listed, message.eventKey);
      if (!claim) {
        counters.skipped += 1;
        return;
      }
      if ('deferred' in claim) {
        counters.deferred += 1;
        return;
      }
      const device = claim.device;
      try {
        const result = await this.options.clientFor(device.environment).send({
          deviceToken: device.token,
          title: message.taskName,
          body: message.status,
          collapseId: message.eventKey,
          url: normalizePushTargetUrl(message.url),
        });
        if (result.ok) {
          await claim.finish('sent');
          counters.sent += 1;
          return;
        }
        counters.failed += 1;
        if (result.status === 410 || INVALID_TOKEN_REASONS.has(result.reason)) {
          await claim.invalidate();
        } else {
          await claim.finish('failed', `${result.status} ${result.reason}`.slice(0, 500));
        }
        logger.warn(
          `iOS 推送被拒绝 device=${device.id} status=${result.status} reason=${result.reason}`,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        counters.failed += 1;
        try {
          await claim.finish('failed', detail.slice(0, 500));
        } catch (storeError) {
          logger.warn(`推送失败后的记录更新失败 device=${device.id}: ${String(storeError)}`);
        }
        logger.warn(`iOS 推送发送失败 device=${device.id}: ${detail}`);
      }
    });

    return counters;
  }
}

export function isApnsConfigured(config: ApnsConfig | undefined): config is ApnsConfig & {
  enabled: true;
  teamId: string;
  keyId: string;
  privateKey: string;
  bundleId: string;
} {
  return (
    config?.enabled === true &&
    !!config.teamId &&
    !!config.keyId &&
    !!config.privateKey &&
    !!config.bundleId
  );
}

export function normalizeDeviceToken(raw: string): string {
  const token = raw.trim().toLowerCase();
  if (!DEVICE_TOKEN_PATTERN.test(token)) throw new Error('APNs 设备令牌无效');
  return token;
}

async function forEachConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex];
        nextIndex += 1;
        if (item) await worker(item);
      }
    }),
  );
}

function toPublicDevice(record: ApnsDeviceRecord): ApnsPublicDevice {
  return {
    id: record.id,
    deviceName: record.deviceName,
    environment: record.environment,
    appVersion: record.appVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
