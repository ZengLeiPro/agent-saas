/**
 * WP2a 后台循环（规范 §3.7、§4.6、§8.4）。
 *
 * 只在 runtime worker 角色启动——判定照抄 `app/runtime.ts` 的 `enableSingletonWorkers`：
 * `processRole === 'all' || processRole === 'runtime-worker'`（`runtime.ts:288`）。
 * `ws-only` / `scheduler-only` 只提供路由，不跑投递与探测，避免多副本重复推送同一事件。
 *
 * 三条独立节拍：
 * - 事件投递（默认每 2 s 一 tick，实际发不发由 outbox 的 `next_attempt_at` 决定）；
 * - 健康探测（默认每 15 s 一 tick，live/ready 的真实间隔由 prober 内部按 §4.6 节流）；
 * - 维护巡检（每小时）：凭据过期与轮换告警、退役签名密钥下线、过期 nonce 清理、停签窗口清理，
 *   以及 WP2b 目录变更流的 30 天保留清理（§3.6）；
 * - 目录投影（WP2b，默认每 60 秒一拍；§3.4 上限 5 分钟，为 §11.2-3 的「5 分钟内」验收留余量）：把 users/membership/
 *   directoryGroups 三源差分成附录 L 的变更事件。目录相关两拍与其余节拍共用同一角色判定，
 *   **不新增任何环境变量**，节拍取值来自 `config.json` 的 `kyApp.directory`。
 */
import type { AlertNotifier } from '../runtime/alertNotifier.js';
import type { KyAppCredentialManager } from './installations/credentials.js';
import type { KyAppInstallationDirectory } from './installations/queries.js';
import type { KyAppEventDispatcher, KyAppDispatchAlert } from './events/dispatcher.js';
import type { KyAppHealthProber, KyAppHealthAlert } from './health/prober.js';
import type { KyAppSigningKeyService } from './keys/service.js';
import type { KyAppNonceStore } from './attest/nonceStore.js';
import type { KyAppSuspensionRegistry } from './sat/suspension.js';

/** `notifyExternal` 的 source；已在 `runtime/platformIncidentPolicy.ts` 登记白名单。 */
export const KY_APP_ALERT_SOURCE = 'ky_app_installation';

export const KY_APP_DISPATCH_INTERVAL_MS = 2_000;
export const KY_APP_PROBE_INTERVAL_MS = 15_000;
export const KY_APP_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
export const KY_APP_DIRECTORY_INTERVAL_MS = 60_000;

export interface KyAppWorkerLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

/**
 * WP2b 目录维护面。做成可选依赖：`kyApp` 已配置但 `userStore` 缺失（例如纯 worker 进程
 * 未装配用户存储）时目录投影整体不启动，其余节拍照常。
 */
export interface KyAppDirectoryMaintenance {
  /** 跑一轮全组织投影对齐。 */
  reconcile: () => Promise<void>;
  /** 删除超过保留期的变更事件，返回删除行数。 */
  purgeExpired: (now: Date) => Promise<number>;
}

export interface KyAppWorkerOptions {
  dispatcher: KyAppEventDispatcher;
  prober: KyAppHealthProber;
  credentials: KyAppCredentialManager;
  directory: KyAppInstallationDirectory;
  keys: KyAppSigningKeyService;
  nonces: KyAppNonceStore;
  suspensions: KyAppSuspensionRegistry;
  alerts: KyAppAlertSink;
  /** WP2b 目录投影与保留清理；与上面的 `directory`（安装实例目录）不是一回事。 */
  directoryMaintenance?: KyAppDirectoryMaintenance;
  logger?: KyAppWorkerLogger;
  dispatchIntervalMs?: number;
  probeIntervalMs?: number;
  maintenanceIntervalMs?: number;
  directoryIntervalMs?: number;
}

/**
 * 告警出口。单独成型而不是挂在 worker 上：dispatcher / prober 在装配期就要拿到回调，
 * 而它们又是 worker 的输入，挂在 worker 上会形成构造循环。
 */
export interface KyAppAlertSink {
  onEventAbandoned: (alert: KyAppDispatchAlert) => void;
  onHealthAlert: (alert: KyAppHealthAlert) => void;
  notifyCredentialExpiring: (installationId: string) => void;
}

export function createKyAppAlertSink(
  alertNotifier?: AlertNotifier,
  logger?: KyAppWorkerLogger,
): KyAppAlertSink {
  const notify = (item: {
    kind: string;
    severity: 'high';
    title: string;
    occurredAt: string;
    dedupeKey: string;
  }): void => {
    void alertNotifier?.notifyExternal(KY_APP_ALERT_SOURCE, [item]).catch((error: unknown) => {
      logger?.warn(`KyAppWorker alert failed: ${errorMessage(error)}`);
    });
  };
  return {
    onEventAbandoned(alert) {
      notify({
        kind: 'ky_app_installation_unhealthy',
        severity: 'high',
        title: `定制项目事件投递放弃：实例 ${alert.installationId} 的 ${alert.type} 超过 24 小时未送达（${alert.reason}）`,
        occurredAt: new Date().toISOString(),
        dedupeKey: `ky_app_event_abandoned:${alert.installationId}:${alert.eventId}`,
      });
    },
    onHealthAlert(alert) {
      const recovered = alert.kind === 'ky_app_installation_recovered';
      notify({
        kind: alert.kind,
        severity: 'high',
        title: recovered
          ? `定制项目实例 ${alert.installationId}（${alert.systemId}）已恢复：${alert.detail}`
          : `定制项目实例 ${alert.installationId}（${alert.systemId}）连续 ${alert.consecutiveFailures} 次探测失败：${alert.detail}`,
        occurredAt: new Date().toISOString(),
        dedupeKey: `${alert.kind}:${alert.installationId}`,
      });
    },
    notifyCredentialExpiring(installationId) {
      notify({
        kind: 'ky_app_installation_unhealthy',
        severity: 'high',
        title: `定制项目实例 ${installationId} 的服务凭据将在 14 天内到期，请安排重叠轮换`,
        occurredAt: new Date().toISOString(),
        dedupeKey: `ky_app_credential_expiring:${installationId}`,
      });
    },
  };
}

/** 与 `runtime.ts:288` 的 `enableSingletonWorkers` 同口径。 */
export function shouldRunKyAppWorker(processRole: string): boolean {
  return processRole === 'all' || processRole === 'runtime-worker';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class KyAppWorker {
  private dispatchTimer?: ReturnType<typeof setInterval>;
  private probeTimer?: ReturnType<typeof setInterval>;
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private directoryTimer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(private readonly options: KyAppWorkerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.dispatchTimer = this.schedule(
      this.options.dispatchIntervalMs ?? KY_APP_DISPATCH_INTERVAL_MS,
      () => this.runDispatch(),
    );
    this.probeTimer = this.schedule(this.options.probeIntervalMs ?? KY_APP_PROBE_INTERVAL_MS, () =>
      this.runProbe(),
    );
    this.maintenanceTimer = this.schedule(
      this.options.maintenanceIntervalMs ?? KY_APP_MAINTENANCE_INTERVAL_MS,
      () => this.runMaintenance(),
    );
    if (this.options.directoryMaintenance) {
      this.directoryTimer = this.schedule(
        this.options.directoryIntervalMs ?? KY_APP_DIRECTORY_INTERVAL_MS,
        () => this.runDirectory(),
      );
    }
    this.options.logger?.info('KyAppWorker started (events dispatcher + health prober)');
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.dispatchTimer) clearInterval(this.dispatchTimer);
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    if (this.directoryTimer) clearInterval(this.directoryTimer);
    this.dispatchTimer = undefined;
    this.probeTimer = undefined;
    this.maintenanceTimer = undefined;
    this.directoryTimer = undefined;
    this.options.logger?.info('KyAppWorker stopped');
  }

  private schedule(intervalMs: number, run: () => Promise<void>): ReturnType<typeof setInterval> {
    const timer = setInterval(() => {
      void run();
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  private async runDispatch(): Promise<void> {
    try {
      await this.options.dispatcher.tick();
    } catch (error) {
      this.options.logger?.warn(`KyAppWorker dispatch tick failed: ${errorMessage(error)}`);
    }
  }

  private async runProbe(): Promise<void> {
    try {
      await this.options.prober.tick();
    } catch (error) {
      this.options.logger?.warn(`KyAppWorker probe tick failed: ${errorMessage(error)}`);
    }
  }

  /** WP2b：目录投影单独一拍，失败只告警不影响其余节拍（下一拍自动重试）。 */
  async runDirectory(): Promise<void> {
    if (!this.options.directoryMaintenance) return;
    try {
      await this.options.directoryMaintenance.reconcile();
    } catch (error) {
      this.options.logger?.warn(`KyAppWorker directory projection failed: ${errorMessage(error)}`);
    }
  }

  /** 维护巡检；公开以便测试直接驱动一拍（生产由定时器调用）。 */
  async runMaintenance(): Promise<void> {
    try {
      await this.options.credentials.expireStale();
      await this.options.keys.retireExpired();
      await this.options.nonces.purgeExpired(new Date());
      this.options.suspensions.prune();
      // WP2b §3.6：变更流保留 30 天，过期号段被清掉即消费端重拉快照的信号。
      if (this.options.directoryMaintenance) {
        await this.options.directoryMaintenance.purgeExpired(new Date());
      }
      for (const installation of await this.options.directory.listLive()) {
        const due = await this.options.credentials.listRotationDue(installation.installationId);
        if (due.length > 0) this.options.alerts.notifyCredentialExpiring(installation.installationId);
      }
    } catch (error) {
      this.options.logger?.warn(`KyAppWorker maintenance failed: ${errorMessage(error)}`);
    }
  }
}
