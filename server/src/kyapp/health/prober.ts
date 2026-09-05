/**
 * WP2a 安装实例健康探测（规范 §4.6、§8.5）。
 *
 * live 每 60 s（公开，无 SAT）、ready 每 5 分钟（`act=platform` SAT）；
 * ready 的 `manifestDigest` 与平台登记的 `registeredDigest` 比对，结果写运行状态表；
 * 连续失败达阈值（默认 5 次）→ 钉钉外部告警，恢复后再通知一次。
 *
 * 探测本身只读：任何一次探测都不改变安装实例状态机，也不阻断能力调用；
 * 它的产出只有运行状态表与告警。
 */
import { randomUUID } from 'node:crypto';

import type { KyAppPlatformConfig } from '../config.js';
import type {
  KyAppInstallationBrief,
  KyAppInstallationDirectory,
} from '../installations/queries.js';
import type { PgKyAppInstallationRuntimeStore } from '../installations/runtimeStore.js';
import type { KyAppOutbound } from '../outbound.js';
import type { KyAppSatIssuer } from '../sat/issuer.js';

export const KY_APP_LIVE_PATH = '/ky/v1/health/live';
export const KY_APP_READY_PATH = '/ky/v1/health/ready';

/** 交给 `alertNotifier.notifyExternal('ky_app_installation', …)` 的一条告警。 */
export interface KyAppHealthAlert {
  installationId: string;
  systemId: string;
  tenantId: string;
  kind: 'ky_app_installation_unhealthy' | 'ky_app_installation_recovered';
  consecutiveFailures: number;
  detail: string;
}

export interface KyAppHealthProberOptions {
  config: KyAppPlatformConfig;
  directory: KyAppInstallationDirectory;
  runtimeStore: PgKyAppInstallationRuntimeStore;
  issuer: KyAppSatIssuer;
  outbound: KyAppOutbound;
  /** 恢复后清掉告警标记（`installations/queries.ts` 的对称操作）。 */
  clearAlert: (installationId: string) => Promise<void>;
  /**
   * §2.5「`ready` 周期复验」：按 ready 节拍复验域名归属。
   * 返回 `false` 表示归属校验没通过；未注入即跳过复验。
   */
  reverifyDomain?: (installationId: string) => Promise<boolean>;
  onAlert?: (alert: KyAppHealthAlert) => void;
  now?: () => number;
}

export interface KyAppHealthTickResult {
  liveProbed: number;
  readyProbed: number;
  alerts: number;
  digestMismatches: number;
  /** 域名归属周期复验未通过的实例数（§2.5）。 */
  domainDrifts: number;
}

function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readKids(source: unknown): string[] {
  if (typeof source !== 'object' || source === null) return [];
  const value = (source as { jwksKids?: unknown }).jwksKids;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export class KyAppHealthProber {
  private readonly now: () => number;
  /** installationId → 上次探测时刻，按 §4.6 的两个间隔分别节流。 */
  private readonly lastLiveAt = new Map<string, number>();
  private readonly lastReadyAt = new Map<string, number>();

  constructor(private readonly options: KyAppHealthProberOptions) {
    this.now = options.now ?? Date.now;
  }

  async tick(now = this.now()): Promise<KyAppHealthTickResult> {
    const result: KyAppHealthTickResult = {
      liveProbed: 0,
      readyProbed: 0,
      alerts: 0,
      digestMismatches: 0,
      domainDrifts: 0,
    };
    const installations = await this.options.directory.listEnabled();
    for (const installation of installations) {
      if (
        this.isDue(
          this.lastLiveAt,
          installation.installationId,
          now,
          this.options.config.probe.liveIntervalMs,
        )
      ) {
        this.lastLiveAt.set(installation.installationId, now);
        result.liveProbed += 1;
        result.alerts += await this.probeLive(installation);
      }
      if (
        this.isDue(
          this.lastReadyAt,
          installation.installationId,
          now,
          this.options.config.probe.readyIntervalMs,
        )
      ) {
        this.lastReadyAt.set(installation.installationId, now);
        result.readyProbed += 1;
        const ready = await this.probeReady(installation);
        if (ready.digestMismatch) result.digestMismatches += 1;
        if (await this.reverifyDomain(installation)) result.domainDrifts += 1;
      }
    }
    return result;
  }

  /** `GET /ky/v1/health/live`：公开端点，不带 SAT；`maintenance` 不算失败。 */
  private async probeLive(installation: KyAppInstallationBrief): Promise<number> {
    const before = await this.options.runtimeStore.get(installation.installationId);
    let status: 'ok' | 'maintenance' | 'failed' = 'failed';
    let detail = '';
    try {
      const response = await this.options.outbound.request({
        baseUrl: installation.baseUrl,
        path: KY_APP_LIVE_PATH,
        method: 'GET',
        requestId: randomUUID(),
      });
      if (response.status !== 200) {
        detail = `live 返回 HTTP ${response.status}`;
      } else if (readString(response.json, 'status') === 'maintenance') {
        status = 'maintenance';
        const eta = readNumber(response.json, 'etaMinutes');
        detail = eta === undefined ? '发布维护中' : `发布维护中，预计 ${eta} 分钟`;
      } else if (readString(response.json, 'status') === 'ok') {
        status = 'ok';
      } else {
        detail = 'live 响应缺少 status';
      }
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }

    const record = await this.options.runtimeStore.recordLive({
      installationId: installation.installationId,
      status,
      ...(detail ? { error: detail } : {}),
    });

    const threshold = this.options.config.probe.failureThreshold;
    if (status === 'failed') {
      // 阈值只在「刚好达到」时告警一次；`alerted_at` 非空表示本轮故障已通知过。
      if (record.consecutiveFailures >= threshold && (before?.alertedAt ?? null) === null) {
        await this.options.runtimeStore.markAlerted(installation.installationId);
        this.options.onAlert?.({
          installationId: installation.installationId,
          systemId: installation.systemId,
          tenantId: installation.tenantId,
          kind: 'ky_app_installation_unhealthy',
          consecutiveFailures: record.consecutiveFailures,
          detail: detail || '连续探测失败',
        });
        return 1;
      }
      return 0;
    }
    if ((before?.alertedAt ?? null) !== null) {
      await this.options.clearAlert(installation.installationId);
      this.options.onAlert?.({
        installationId: installation.installationId,
        systemId: installation.systemId,
        tenantId: installation.tenantId,
        kind: 'ky_app_installation_recovered',
        consecutiveFailures: 0,
        detail: status === 'maintenance' ? '已进入维护态，live 可达' : 'live 已恢复',
      });
      return 1;
    }
    return 0;
  }

  /** `GET /ky/v1/health/ready`：`act=platform` SAT；digest 不一致只记录，不改状态机。 */
  private async probeReady(
    installation: KyAppInstallationBrief,
  ): Promise<{ digestMismatch: boolean }> {
    const requestId = randomUUID();
    try {
      const sat = await this.options.issuer.issue({
        act: 'platform',
        tenantId: installation.tenantId,
        installationId: installation.installationId,
        systemId: installation.systemId,
        rid: requestId,
      });
      const response = await this.options.outbound.request({
        baseUrl: installation.baseUrl,
        path: KY_APP_READY_PATH,
        method: 'GET',
        requestId,
        headers: { authorization: `Bearer ${sat.token}` },
      });
      if (response.status !== 200) {
        await this.options.runtimeStore.recordReady({
          installationId: installation.installationId,
          status: 'failed',
          error: `ready 返回 HTTP ${response.status}`,
        });
        return { digestMismatch: false };
      }
      const manifestDigest = readString(response.json, 'manifestDigest');
      const directorySync = (response.json as { deps?: { directorySync?: unknown } } | null)?.deps
        ?.directorySync;
      const registered = installation.registeredDigest;
      const digestMismatch =
        registered !== null && manifestDigest !== undefined && manifestDigest !== registered;
      await this.options.runtimeStore.recordReady({
        installationId: installation.installationId,
        status: 'ok',
        ...(manifestDigest ? { manifestDigest } : {}),
        ...(readNumber(response.json, 'contractVersion') === undefined
          ? {}
          : { contractVersion: readNumber(response.json, 'contractVersion')! }),
        ...(readString(response.json, 'appVersion')
          ? { appVersion: readString(response.json, 'appVersion')! }
          : {}),
        ...(readNumber(directorySync, 'checkpoint') === undefined
          ? {}
          : { directoryCheckpoint: String(readNumber(directorySync, 'checkpoint')) }),
        ...(readNumber(directorySync, 'ageSeconds') === undefined
          ? {}
          : { directoryAgeSeconds: Math.floor(readNumber(directorySync, 'ageSeconds')!) }),
        jwksKids: readKids(response.json),
        ...(digestMismatch
          ? { error: `manifestDigest 与登记不一致（登记 ${registered}，上报 ${manifestDigest}）` }
          : {}),
      });
      return { digestMismatch };
    } catch (error) {
      await this.options.runtimeStore.recordReady({
        installationId: installation.installationId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      return { digestMismatch: false };
    }
  }

  /**
   * §2.5：`ready` 节拍上复验域名归属。失败只告警 + 记运行状态，
   * **不改安装实例状态机**——域名临时解析异常不该让客户的系统直接下线。
   */
  private async reverifyDomain(installation: KyAppInstallationBrief): Promise<boolean> {
    const reverify = this.options.reverifyDomain;
    if (!reverify) return false;
    let verified: boolean;
    try {
      verified = await reverify(installation.installationId);
    } catch {
      return false;
    }
    if (verified) return false;
    await this.options.runtimeStore.recordReady({
      installationId: installation.installationId,
      status: 'ok',
      error: '域名归属周期复验未通过：DNS TXT 记录已不匹配登记的验证令牌',
    });
    this.options.onAlert?.({
      installationId: installation.installationId,
      systemId: installation.systemId,
      tenantId: installation.tenantId,
      kind: 'ky_app_installation_unhealthy',
      consecutiveFailures: 0,
      detail: '域名归属周期复验未通过',
    });
    return true;
  }

  private isDue(
    marks: Map<string, number>,
    installationId: string,
    now: number,
    intervalMs: number,
  ): boolean {
    const last = marks.get(installationId);
    return last === undefined || now - last >= intervalMs;
  }
}
