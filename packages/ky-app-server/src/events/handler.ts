/**
 * §3.7 平台 → 定制项目事件处理。
 *
 * 安装状态事件带单调 `stateVersion`：只接受本地 + 1，更小忽略并 ack，更大回 409 `state_gap`；
 * `deleted` 是吸收终态；去重记录、状态变更、ack 同事务提交；`disabled` 状态下仍接受事件。
 * `jwks.rotated` 预取、`jwks.revoke` 清缓存与负缓存、`jwks.probe` 验签后回 `verifiedKid`。
 */
import { decodeProtectedHeader, jwtVerify } from 'jose';

import {
  JWT_TYP,
  PLATFORM_EVENT_TYPES,
  type InstallationState,
  type PlatformEvent,
  type PlatformEventAck,
} from '@kaiyan/ky-app-contract';

import type { KyAppConfig } from '../config/index.js';
import { KyAppError } from '../errors.js';
import type { JwksClient } from '../jwks/client.js';
import type { InstallationStateRecord, InstallationStateStore } from './store.js';

export interface EventsHandlerOptions {
  config: KyAppConfig;
  store: InstallationStateStore;
  jwks: JwksClient;
  now?: () => number;
  /** 事件落地后的回调（日志 / 告警）。 */
  onEvent?: (event: PlatformEvent, ack: PlatformEventAck) => void;
}

export interface EventsHandler {
  handle(event: unknown): Promise<PlatformEventAck>;
  /** 当前安装实例状态，供鉴权中间件与 `health/ready` 使用。 */
  state(): Promise<InstallationStateRecord>;
}

const STATE_BY_TYPE: Readonly<Record<string, InstallationState>> = {
  'installation.disabled': 'disabled',
  'installation.enabled': 'enabled',
  'installation.deleted': 'deleted',
};

function assertShape(event: unknown, config: KyAppConfig): PlatformEvent {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    throw new KyAppError('invalid_input', { message: '事件必须是对象' });
  }
  const value = event as Record<string, unknown>;
  if (typeof value.eventId !== 'string' || value.eventId === '') {
    throw new KyAppError('invalid_input', { message: '事件缺少 eventId' });
  }
  if (value.iid !== config.installationId) {
    throw new KyAppError('invalid_input', { message: '事件 iid 与安装实例不符' });
  }
  if (!Number.isSafeInteger(value.stateVersion) || (value.stateVersion as number) < 0) {
    throw new KyAppError('invalid_input', { message: '事件 stateVersion 非法' });
  }
  if (
    typeof value.type !== 'string' ||
    !(PLATFORM_EVENT_TYPES as readonly string[]).includes(value.type)
  ) {
    throw new KyAppError('invalid_input', { message: `未知事件类型：${String(value.type)}` });
  }
  return event as PlatformEvent;
}

export function createEventsHandler(options: EventsHandlerOptions): EventsHandler {
  const now = options.now ?? Date.now;

  /** `jwks.probe`：用 JWKS 里的 `kid` 验 `probeSat` 的签名，成功即回 `verifiedKid`。 */
  async function probe(kid: string, probeSat: string): Promise<string | undefined> {
    let header: { kid?: string; alg?: string; typ?: string };
    try {
      header = decodeProtectedHeader(probeSat);
    } catch {
      return undefined;
    }
    if (header.alg !== 'ES256' || header.typ !== JWT_TYP.sat) return undefined;
    if (header.kid !== kid) return undefined;
    try {
      const key = await options.jwks.getKey(kid);
      await jwtVerify(probeSat, key, {
        algorithms: ['ES256'],
        typ: JWT_TYP.sat,
        issuer: options.config.issuer,
        audience: options.config.systemId,
        currentDate: new Date(now()),
        clockTolerance: 10,
      });
      return kid;
    } catch {
      return undefined;
    }
  }

  async function nextState(
    event: PlatformEvent,
    current: InstallationStateRecord,
  ): Promise<InstallationStateRecord> {
    const target = STATE_BY_TYPE[event.type];
    if (target === undefined) return current;
    // `deleted` 是吸收终态：之后任何状态事件都不再改变状态，但仍要 ack。
    if (current.state === 'deleted') return current;
    if (event.stateVersion <= current.stateVersion) return current;
    if (event.stateVersion > current.stateVersion + 1) {
      throw new KyAppError('state_gap', {
        message: `stateVersion 跳号：本地 ${current.stateVersion}，收到 ${event.stateVersion}`,
      });
    }
    return { state: target, stateVersion: event.stateVersion };
  }

  return {
    async handle(raw: unknown): Promise<PlatformEventAck> {
      const event = assertShape(raw, options.config);
      const replayed = await options.store.findAck(event.eventId);
      if (replayed !== null) return replayed;

      const current = await options.store.getState();
      const state = await nextState(event, current);

      let verifiedKid: string | undefined;
      switch (event.type) {
        case 'jwks.rotated':
          await options.jwks.prefetch(event.payload.newKid);
          break;
        case 'jwks.revoke':
          options.jwks.revoke(event.payload.kid);
          break;
        case 'jwks.probe':
          verifiedKid = await probe(event.payload.kid, event.payload.probeSat);
          break;
        default:
          break;
      }

      const ack: PlatformEventAck = {
        eventId: event.eventId,
        ack: true,
        stateVersion: state.stateVersion,
        ...(verifiedKid === undefined ? {} : { verifiedKid }),
      };
      await options.store.commit({ eventId: event.eventId, ack, state });
      options.onEvent?.(event, ack);
      return ack;
    },

    state: () => options.store.getState(),
  };
}
