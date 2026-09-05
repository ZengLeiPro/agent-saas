/**
 * WP2a 平台 → 定制项目事件投递（规范 §3.7、§8.4）。
 *
 * 每个 tick：取到期事件 → 按安装实例分组、按 `stateVersion` 升序**串行**投递
 * （同一实例的事件必须保序，否则对端只会一直回 `state_gap`）→ 签 `act=platform` SAT
 * （`rid` = `X-KY-Request-Id`）→ 经 `outbound.ts` POST `{baseUrl}/ky/v1/events`。
 *
 * 应答处置：
 * - 200 `{ack:true}` → 标 delivered（`jwks.probe` 的 `verifiedKid` 一并落库，作为 §8.4 切换证据）；
 * - 409 `state_gap` → 把该实例更早的未 ack 事件立刻重放，本轮不再推进后续事件；
 * - 其余失败 → 指数退避（1 s 起、15 分钟封顶），超过 24 小时重试窗口标 `abandoned` 并告警。
 */
import { randomUUID } from 'node:crypto';

import type { KyAppPlatformConfig } from '../config.js';
import type { KyAppSigningKeyService } from '../keys/service.js';
import type {
  KyAppInstallationBrief,
  KyAppInstallationDirectory,
} from '../installations/queries.js';
import type { KyAppOutbound } from '../outbound.js';
import { KyAppOutboundError } from '../outbound.js';
import type { KyAppSatIssuer } from '../sat/issuer.js';
import type { PgKyAppSystemStore } from '../systems/store.js';
import type { KyAppOutboundEvent, PgKyAppOutboundEventStore } from './store.js';

/** 事件投递路径（规范 §3.7）。 */
export const KY_APP_EVENTS_PATH = '/ky/v1/events';

/** 被放弃的事件告警项；由 worker 交给 `alertNotifier.notifyExternal`。 */
export interface KyAppDispatchAlert {
  installationId: string;
  eventId: string;
  type: string;
  reason: string;
}

export interface KyAppEventDispatcherOptions {
  config: KyAppPlatformConfig;
  store: PgKyAppOutboundEventStore;
  systems: PgKyAppSystemStore;
  directory: KyAppInstallationDirectory;
  keys: KyAppSigningKeyService;
  issuer: KyAppSatIssuer;
  outbound: KyAppOutbound;
  onAbandoned?: (alert: KyAppDispatchAlert) => void;
  now?: () => number;
  /** 单个 tick 取多少条待发事件，默认 50。 */
  batchSize?: number;
}

export interface KyAppDispatchTickResult {
  attempted: number;
  delivered: number;
  failed: number;
  abandoned: number;
  replayed: number;
}

function ackVerifiedKid(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const value = (body as { verifiedKid?: unknown }).verifiedKid;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isStateGap(status: number, body: unknown): boolean {
  if (status !== 409) return false;
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: { code?: unknown } }).error;
  const nested =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const flat = (body as { code?: unknown }).code;
  return nested === 'state_gap' || flat === 'state_gap';
}

export class KyAppEventDispatcher {
  private readonly now: () => number;
  private readonly batchSize: number;

  constructor(private readonly options: KyAppEventDispatcherOptions) {
    this.now = options.now ?? Date.now;
    this.batchSize = options.batchSize ?? 50;
  }

  async tick(now = new Date(this.now())): Promise<KyAppDispatchTickResult> {
    const result: KyAppDispatchTickResult = {
      attempted: 0,
      delivered: 0,
      failed: 0,
      abandoned: 0,
      replayed: 0,
    };
    const due = await this.options.store.listDue(now, this.batchSize);
    const byInstallation = new Map<string, KyAppOutboundEvent[]>();
    for (const event of due) {
      const bucket = byInstallation.get(event.installationId) ?? [];
      bucket.push(event);
      byInstallation.set(event.installationId, bucket);
    }
    for (const [installationId, events] of byInstallation) {
      const installation = await this.options.systems.getInstallation(installationId);
      if (!installation) continue;
      for (const event of events) {
        result.attempted += 1;
        const outcome = await this.deliver(event, installation, now);
        if (outcome === 'delivered') {
          result.delivered += 1;
          continue;
        }
        if (outcome === 'state_gap') {
          result.replayed += await this.replayEarlier(event, installation, now);
          // 保序：本实例本轮不再推进后续事件，等下一次 tick。
          break;
        }
        if (outcome === 'abandoned') result.abandoned += 1;
        else result.failed += 1;
        break;
      }
    }
    return result;
  }

  /**
   * §8.4 轮换编排：生成 next 密钥 → 给每个 enabled 实例入队 `jwks.rotated` + `jwks.probe`。
   * 切换本身不在这里做，必须等所有实例都回了 `verifiedKid`（`promoteWhenAllVerified`）。
   */
  async rotateAndProbe(): Promise<{ newKid: string; probed: number }> {
    const { newKid } = await this.options.keys.rotate();
    const installations = await this.listEnabled();
    for (const installation of installations) {
      await this.enqueueJwksEvent(installation, 'jwks.rotated', { newKid });
      const probeSat = await this.options.issuer.issue({
        act: 'platform',
        tenantId: installation.tenantId,
        installationId: installation.installationId,
        systemId: installation.systemId,
        rid: randomUUID(),
        signWithKid: newKid,
      });
      await this.enqueueJwksEvent(installation, 'jwks.probe', {
        kid: newKid,
        probeSat: probeSat.token,
      });
    }
    return { newKid, probed: installations.length };
  }

  /** 紧急撤销：入队 `jwks.revoke`，让各实例立即清缓存与负缓存（§3.7）。 */
  async broadcastRevoke(kid: string): Promise<number> {
    const installations = await this.listEnabled();
    for (const installation of installations) {
      await this.enqueueJwksEvent(installation, 'jwks.revoke', { kid });
    }
    return installations.length;
  }

  /**
   * 只有**所有 enabled 实例**都回报了与目标一致的 `verifiedKid`，才允许切换签发密钥。
   * 任何一个实例没验通过就切，等于让它在下一次验签时 fail-closed。
   */
  async promoteWhenAllVerified(newKid: string): Promise<{ promoted: boolean; pending: string[] }> {
    const installations = await this.listEnabled();
    const pending: string[] = [];
    for (const installation of installations) {
      const events = await this.options.store.listSince(installation.installationId, 1);
      const verified = events.some(
        (event) =>
          event.type === 'jwks.probe' &&
          event.status === 'delivered' &&
          event.verifiedKid === newKid,
      );
      if (!verified) pending.push(installation.installationId);
    }
    if (installations.length === 0 || pending.length > 0) return { promoted: false, pending };
    await this.options.keys.promote(newKid, newKid);
    return { promoted: true, pending: [] };
  }

  private async listEnabled(): Promise<KyAppInstallationBrief[]> {
    return this.options.directory.listEnabled();
  }

  /** jwks 事件不属于安装状态流，用秒级时间戳当 `stateVersion`：单调、且同秒内天然幂等。 */
  private async enqueueJwksEvent(
    installation: KyAppInstallationBrief,
    type: 'jwks.rotated' | 'jwks.revoke' | 'jwks.probe',
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.options.store.enqueue({
      installationId: installation.installationId,
      stateVersion: Math.floor(this.now() / 1000),
      type,
      payload,
      retryWindowMs: this.options.config.events.retryWindowMs,
      now: new Date(this.now()),
    });
  }

  private async deliver(
    event: KyAppOutboundEvent,
    installation: { installationId: string; tenantId: string; systemId: string; baseUrl: string },
    now: Date,
  ): Promise<'delivered' | 'state_gap' | 'failed' | 'abandoned'> {
    const requestId = randomUUID();
    let token: string;
    try {
      const sat = await this.options.issuer.issue({
        act: 'platform',
        tenantId: installation.tenantId,
        installationId: installation.installationId,
        systemId: installation.systemId,
        rid: requestId,
      });
      token = sat.token;
    } catch (error) {
      return this.fail(event, `SAT 签发失败：${message(error)}`, now);
    }

    let response: { status: number; json: unknown };
    try {
      response = await this.options.outbound.request({
        baseUrl: installation.baseUrl,
        path: KY_APP_EVENTS_PATH,
        method: 'POST',
        requestId,
        headers: { authorization: `Bearer ${token}` },
        jsonBody: {
          eventId: event.eventId,
          iid: event.installationId,
          stateVersion: event.stateVersion,
          type: event.type,
          occurredAt: event.occurredAt,
          payload: event.payload,
        },
      });
    } catch (error) {
      const code = error instanceof KyAppOutboundError ? error.code : 'upstream_unavailable';
      return this.fail(event, `出站失败（${code}）：${message(error)}`, now);
    }

    if (response.status === 200) {
      await this.options.store.markDelivered(event.eventId, ackVerifiedKid(response.json));
      return 'delivered';
    }
    if (isStateGap(response.status, response.json)) {
      await this.options.store.markFailed({
        eventId: event.eventId,
        error: '对端回 409 state_gap，已安排重放更早的事件',
        now,
      });
      return 'state_gap';
    }
    return this.fail(event, `对端返回 HTTP ${response.status}`, now);
  }

  /** 对端回 `state_gap`：把该实例所有更早的未 ack 事件立即置为可发，下一轮按序补齐。 */
  private async replayEarlier(
    event: KyAppOutboundEvent,
    installation: { installationId: string; tenantId: string; systemId: string; baseUrl: string },
    now: Date,
  ): Promise<number> {
    const earlier = (await this.options.store.listSince(event.installationId, 1))
      .filter((item) => item.status === 'pending' && item.stateVersion < event.stateVersion)
      .sort((left, right) => left.stateVersion - right.stateVersion);
    let replayed = 0;
    for (const item of earlier) {
      const outcome = await this.deliver(item, installation, now);
      if (outcome !== 'delivered') break;
      replayed += 1;
    }
    return replayed;
  }

  private async fail(
    event: KyAppOutboundEvent,
    reason: string,
    now: Date,
  ): Promise<'failed' | 'abandoned'> {
    const updated = await this.options.store.markFailed({
      eventId: event.eventId,
      error: reason,
      now,
    });
    if (updated?.status === 'abandoned') {
      this.options.onAbandoned?.({
        installationId: event.installationId,
        eventId: event.eventId,
        type: event.type,
        reason,
      });
      return 'abandoned';
    }
    return 'failed';
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
