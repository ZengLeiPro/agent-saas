import type { NotifyChannel } from '../cron/notifyChannel.js';
import { createWebPushNotifyChannel } from '../cron/notifyChannels/index.js';
import type { NotifyConfig } from '../cron/types.js';
import type { UserStore } from '../data/users/store.js';
import type { PgEventStore } from '../runtime/pgEventStore.js';
import type { PgSessionProjectionStore } from '../runtime/sessionProjectionStore.js';
import type { PlatformEvent } from '../runtime/types.js';
import type { Logger } from '../utils/logger.js';
import { notifyWebPushForRuntimeEvent } from '../webPush/runtimeEventNotifier.js';
import { isWebPushConfigured, WebPushService } from '../webPush/service.js';
import { PgWebPushStore } from '../webPush/store.js';
import type { AppConfig } from '../types/index.js';

interface RuntimeWebPushAssemblyOptions {
  config: AppConfig;
  userStore?: UserStore;
  getSessionStore: () => PgSessionProjectionStore | undefined;
  logger: Logger;
}

export interface RuntimeWebPushAssembly {
  readonly service: WebPushService | undefined;
  initialize(eventStore: PgEventStore, tablePrefix?: string): Promise<void>;
  warnIfUnavailable(): void;
  appendCronChannel(channels: NotifyChannel[], notifyConfig: NotifyConfig): void;
  deliverRuntimeEvent(event: PlatformEvent): void;
}

/** Keeps Web Push startup and runtime delivery wiring in one lifecycle-owned adapter. */
export function createRuntimeWebPushAssembly(
  options: RuntimeWebPushAssemblyOptions,
): RuntimeWebPushAssembly {
  let service: WebPushService | undefined;

  return {
    get service() {
      return service;
    },

    async initialize(eventStore, tablePrefix) {
      if (!isWebPushConfigured(options.config.webPush)) return;
      try {
        const store = new PgWebPushStore({ pool: eventStore.pool, tablePrefix });
        await store.init();
        service = new WebPushService(store, options.config.webPush);
      } catch (err) {
        options.logger.warn(
          `Web Push init failed; desktop notifications disabled: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    warnIfUnavailable() {
      if (options.config.webPush?.enabled && !service) {
        options.logger.warn('Web Push 已启用但未完成初始化；任务执行仍继续，桌面通知将降级为站内结果');
      }
    },

    appendCronChannel(channels, notifyConfig) {
      const shouldWebPush = notifyConfig.channel === 'web' || notifyConfig.channel === 'both';
      if (shouldWebPush && service) {
        channels.push(createWebPushNotifyChannel({ service, userStore: options.userStore }));
      }
    },

    deliverRuntimeEvent(event) {
      const sessionStore = options.getSessionStore();
      if (!service || !sessionStore) return;
      void notifyWebPushForRuntimeEvent(event, { service, sessionStore }).catch((err) => {
        options.logger.warn(
          `Web Push runtime event delivery failed: event=${event.type} error=${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
  };
}
