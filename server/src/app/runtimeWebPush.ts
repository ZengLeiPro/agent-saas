import type { NotifyChannel } from '../cron/notifyChannel.js';
import { createWebPushNotifyChannel } from '../cron/notifyChannels/index.js';
import type { NotifyConfig } from '../cron/types.js';
import type { UserStore } from '../data/users/store.js';
import type { PgEventStore } from '../runtime/pgEventStore.js';
import type { PgSessionProjectionStore } from '../runtime/sessionProjectionStore.js';
import type { PgTaskboardStore } from '../taskboard/store.js';
import { TaskboardStatusNotificationWorker } from '../taskboard/statusNotificationWorker.js';
import type { PlatformEvent } from '../runtime/types.js';
import type { Logger } from '../utils/logger.js';
import { createApnsClients } from '../apns/client.js';
import { ApnsService, isApnsConfigured } from '../apns/service.js';
import { PgApnsDeviceStore } from '../apns/store.js';
import type { PushSender } from '../push/sender.js';
import { createPushFanout } from '../push/sender.js';
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
  /** 浏览器 Web Push 订阅管理（路由用）。 */
  readonly service: WebPushService | undefined;
  /** iOS APNs 设备管理（路由用）。 */
  readonly apnsService: ApnsService | undefined;
  /** 统一投递面：扇出到全部已配置通道。任一通道可用即存在。 */
  readonly sender: PushSender | undefined;
  initialize(eventStore: PgEventStore, tablePrefix?: string): Promise<void>;
  warnIfUnavailable(): void;
  appendCronChannel(channels: NotifyChannel[], notifyConfig: NotifyConfig): void;
  deliverRuntimeEvent(event: PlatformEvent): Promise<void>;
}

export function startTaskboardStatusNotificationWorker(
  store: PgTaskboardStore,
  sender: PushSender | undefined,
  enabled: boolean,
  userStore?: UserStore,
): TaskboardStatusNotificationWorker | undefined {
  if (!sender || !enabled) return undefined;
  const worker = new TaskboardStatusNotificationWorker({
    pool: store.pool,
    tasksTable: store.tasksTable,
    boardsTable: store.boardsTable,
    outboxTable: store.statusNotificationOutboxTable,
    service: sender,
    userStore,
  });
  worker.start();
  return worker;
}

/**
 * Web Push 与 APNs 两条通道的启动装配与运行期投递接线，生命周期归 runtime 所有。
 * 两条通道各自独立初始化；任一失败只降级该通道，不影响任务执行与另一通道。
 */
export function createRuntimeWebPushAssembly(
  options: RuntimeWebPushAssemblyOptions,
): RuntimeWebPushAssembly {
  let service: WebPushService | undefined;
  let apnsService: ApnsService | undefined;
  let sender: PushSender | undefined;

  return {
    get service() {
      return service;
    },
    get apnsService() {
      return apnsService;
    },
    get sender() {
      return sender;
    },

    async initialize(eventStore, tablePrefix) {
      if (isWebPushConfigured(options.config.webPush)) {
        try {
          const store = new PgWebPushStore({ pool: eventStore.pool, tablePrefix });
          await store.init();
          service = new WebPushService(store, options.config.webPush);
        } catch (err) {
          options.logger.warn(
            `Web Push init failed; desktop notifications disabled: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (isApnsConfigured(options.config.apns)) {
        try {
          const store = new PgApnsDeviceStore({ pool: eventStore.pool, tablePrefix });
          await store.init();
          const { teamId, keyId, privateKey, bundleId, environment } = options.config.apns;
          apnsService = new ApnsService(store, {
            defaultEnvironment: environment,
            clientFor: createApnsClients({ teamId, keyId, privateKey, bundleId }),
          });
        } catch (err) {
          options.logger.warn(
            `APNs init failed; iOS notifications disabled: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      const transports: PushSender[] = [];
      if (service) transports.push(service);
      if (apnsService) transports.push(apnsService);
      sender = createPushFanout(transports);
    },

    warnIfUnavailable() {
      if (options.config.webPush?.enabled && !service) {
        options.logger.warn('Web Push 已启用但未完成初始化；任务执行仍继续，桌面通知将降级为站内结果');
      }
      if (options.config.apns?.enabled && !apnsService) {
        options.logger.warn('APNs 已启用但未完成初始化；任务执行仍继续，iOS 推送将降级为站内结果');
      }
    },

    appendCronChannel(channels, notifyConfig) {
      const shouldPush = notifyConfig.channel === 'web' || notifyConfig.channel === 'both';
      if (shouldPush && sender) {
        channels.push(createWebPushNotifyChannel({ service: sender, userStore: options.userStore }));
      }
    },

    async deliverRuntimeEvent(event) {
      const sessionStore = options.getSessionStore();
      if (!sender || !sessionStore) return;
      try {
        await notifyWebPushForRuntimeEvent(event, { service: sender, sessionStore });
      } catch (err) {
        options.logger.warn(
          `Web Push runtime event delivery failed: event=${event.type} error=${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    },
  };
}
