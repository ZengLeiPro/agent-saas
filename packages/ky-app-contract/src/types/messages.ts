/** §5.3 / §5.4 postMessage 信封与消息表。 */

/** 壳 → 子 的消息 type。 */
export const SHELL_TO_APP_MESSAGE_TYPES = [
  'init',
  'token.refresh',
  'token.refresh.error',
  'route.navigate',
  'link.result',
  'theme.changed',
  'visibility',
] as const;

/** 子 → 壳 的消息 type。 */
export const APP_TO_SHELL_MESSAGE_TYPES = [
  'ready',
  'init.ack',
  'token.request',
  'route.result',
  'route.changed',
  'perm.changed',
  'agent.open',
  'link.open',
  'toast',
  'logout.request',
] as const;

export type ShellToAppMessageType = (typeof SHELL_TO_APP_MESSAGE_TYPES)[number];
export type AppToShellMessageType = (typeof APP_TO_SHELL_MESSAGE_TYPES)[number];
export type KyMessageType = ShellToAppMessageType | AppToShellMessageType;

/** 信封：`{ ns:'ky', v:1, type, id?, navId?, payload? }`（§5.3）。 */
export interface KyMessageEnvelope<TType extends string = KyMessageType, TPayload = unknown> {
  ns: 'ky' | 'ky-experimental';
  v: 1;
  type: TType;
  /** 需应答消息的顶层关联 id（5 s 超时）；重复 (type,id) 重放缓存应答，副作用只执行一次。 */
  id?: string;
  /** 路由回声抑制。 */
  navId?: string;
  payload?: TPayload;
}

/** 握手状态机（§5.4）。 */
export const HANDSHAKE_STATES = ['loading', 'attesting', 'ready', 'init', 'active'] as const;
export type HandshakeState = (typeof HANDSHAKE_STATES)[number];

export interface ReadyPayload {
  contractVersion: 1;
  path: string;
  installationId: string;
  /** attest JWT，重发复用同一个。 */
  attestation: string;
}

export interface InitPayload {
  token: string;
  tokenExp: number;
  user: { id: string; displayName: string; isTenantAdmin: boolean };
  theme: string;
  locale: string;
  installationId: string;
  contractVersion: 1;
}

export interface TokenRefreshPayload {
  token: string;
  tokenExp: number;
}

export const TOKEN_REFRESH_ERROR_REASONS = [
  'session_expired',
  'installation_disabled',
  'user_disabled',
  'temporary',
] as const;
export type TokenRefreshErrorReason = (typeof TOKEN_REFRESH_ERROR_REASONS)[number];

export interface TokenRefreshErrorPayload {
  /** `temporary` 指数退避重试；其余停止请求并显示文案。 */
  reason: TokenRefreshErrorReason;
}

export interface RouteNavigatePayload {
  path: string;
}

export interface RouteResultPayload {
  ok: boolean;
  path?: string;
  /** `forbidden` → 壳刷新 /me、导航 landing。 */
  reason?: 'not_found' | 'forbidden';
}

export interface RouteChangedPayload {
  path: string;
  title?: string;
}

export interface PermChangedPayload {
  /** 来自 X-KY-Perm-Version 变化。 */
  permVersion: string;
}

export interface ThemeChangedPayload {
  theme: string;
}

export interface VisibilityPayload {
  visible: boolean;
}

/** 壳只预填并标注「来自《系统名》」，用户再点发送；≤ 500 字纯文本。 */
export interface AgentOpenPayload {
  prompt?: string;
  context?: { entity: { type: string; id: string; label: string }; summary?: string };
}

/** 仅 https:、无 userinfo、非 IP、host ∈ manifest externalLinkHosts。 */
export interface LinkOpenPayload {
  url: string;
}

export interface LinkResultPayload {
  ok: boolean;
}

export interface ToastPayload {
  level: 'info' | 'success' | 'warning' | 'error';
  /** 纯文本 ≤ 200。 */
  message: string;
}

/** 消息 type → payload 的映射表，供收发两端做穷尽性检查。 */
export interface KyMessagePayloadMap {
  ready: ReadyPayload;
  init: InitPayload;
  'init.ack': undefined;
  'token.request': undefined;
  'token.refresh': TokenRefreshPayload;
  'token.refresh.error': TokenRefreshErrorPayload;
  'route.navigate': RouteNavigatePayload;
  'route.result': RouteResultPayload;
  'route.changed': RouteChangedPayload;
  'perm.changed': PermChangedPayload;
  'theme.changed': ThemeChangedPayload;
  visibility: VisibilityPayload;
  'agent.open': AgentOpenPayload;
  'link.open': LinkOpenPayload;
  'link.result': LinkResultPayload;
  toast: ToastPayload;
  'logout.request': undefined;
}

export type KyMessage<TType extends KyMessageType = KyMessageType> = KyMessageEnvelope<
  TType,
  KyMessagePayloadMap[TType]
>;

/** 需要应答的消息对：请求 type → 应答 type（§5.3）。 */
export const MESSAGE_RESPONSE_PAIRS = {
  ready: ['init'],
  init: ['init.ack'],
  'token.request': ['token.refresh', 'token.refresh.error'],
  'route.navigate': ['route.result'],
  'link.open': ['link.result'],
} as const satisfies Partial<Record<KyMessageType, readonly KyMessageType[]>>;

/** agent.open 的 prompt 上限（§5.4）。 */
export const AGENT_OPEN_PROMPT_MAX_LENGTH = 500;
/** toast 文本上限（§5.4）。 */
export const TOAST_MESSAGE_MAX_LENGTH = 200;
