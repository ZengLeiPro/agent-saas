/** §3.7 平台 → 定制项目事件（`POST /ky/v1/events`，act=platform）。 */

export const PLATFORM_EVENT_TYPES = [
  'installation.disabled',
  'installation.enabled',
  'installation.deleted',
  'jwks.rotated',
  'jwks.revoke',
  'jwks.probe',
] as const;

export type PlatformEventType = (typeof PLATFORM_EVENT_TYPES)[number];

interface PlatformEventBase {
  eventId: string;
  iid: string;
  /** 安装状态事件带单调 stateVersion：只接受本地 + 1。 */
  stateVersion: number;
  occurredAt: string;
}

export interface InstallationDisabledEvent extends PlatformEventBase {
  type: 'installation.disabled';
  payload?: Record<string, never>;
}

export interface InstallationEnabledEvent extends PlatformEventBase {
  type: 'installation.enabled';
  payload?: Record<string, never>;
}

export interface InstallationDeletedEvent extends PlatformEventBase {
  type: 'installation.deleted';
  payload?: Record<string, never>;
}

export interface JwksRotatedEvent extends PlatformEventBase {
  type: 'jwks.rotated';
  payload: { newKid: string };
}

export interface JwksRevokeEvent extends PlatformEventBase {
  type: 'jwks.revoke';
  payload: { kid: string };
}

export interface JwksProbeEvent extends PlatformEventBase {
  type: 'jwks.probe';
  payload: { kid: string; probeSat: string };
}

/** 按 `type` 判别的联合类型。 */
export type PlatformEvent =
  | InstallationDisabledEvent
  | InstallationEnabledEvent
  | InstallationDeletedEvent
  | JwksRotatedEvent
  | JwksRevokeEvent
  | JwksProbeEvent;

/** 事件 ack。`jwks.probe` 验签成功后回 verifiedKid。 */
export interface PlatformEventAck {
  eventId: string;
  ack: true;
  stateVersion: number;
  verifiedKid?: string;
}
