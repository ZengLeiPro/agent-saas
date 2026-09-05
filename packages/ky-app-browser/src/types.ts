/**
 * `@kaiyan/ky-app-browser` 的公共类型（§5 嵌入契约的子端一侧）。
 *
 * 本包在**定制项目子端 iframe 内**运行，不依赖任何框架，也不读 `process.env` /
 * `import.meta.env`：一切外部输入都从 `createKyApp(options)` 注入，便于 jsdom 下用假
 * `window` / 假时钟测试。
 */
import type {
  InitPayload,
  TokenRefreshErrorReason,
  ToastPayload,
  AgentOpenPayload,
} from '@kaiyan/ky-app-contract';

/** 定时器句柄：不绑定 Node 的 `Timeout` 也不绑定浏览器的 `number`。 */
export type KyTimerHandle = unknown;

/** 可注入的定时器（测试用假时钟替换）。 */
export interface KyTimers {
  setTimeout(handler: () => void, delayMs: number): KyTimerHandle;
  clearTimeout(handle: KyTimerHandle): void;
}

/** 真实环境的默认定时器。 */
export const defaultTimers: KyTimers = {
  setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as number);
  },
};

/** `message` 事件的最小形状（真实 `MessageEvent` 结构上兼容）。 */
export interface KyMessageEventLike {
  readonly origin: string;
  readonly source: unknown;
  readonly data: unknown;
}

export type KyMessageListener = (event: KyMessageEventLike) => void;

/** 壳窗口（`window.parent`）的最小形状。 */
export interface KyParentLike {
  postMessage(message: unknown, targetOrigin: string): void;
}

/** `history` 的最小形状，供 `syncHistory()` 使用。 */
export interface KyHistoryLike {
  pushState(data: unknown, unused: string, url?: string | null): void;
  replaceState(data: unknown, unused: string, url?: string | null): void;
}

/**
 * 子端窗口的最小形状。真实的 `Window` 结构上可直接赋值（已用 tsc 验证），
 * 测试则传手工构造的假对象。
 */
export interface KyWindowLike {
  readonly location: { readonly href: string };
  readonly parent: KyParentLike;
  readonly document?: { readonly referrer?: string };
  readonly history?: KyHistoryLike;
  addEventListener(type: 'message', listener: KyMessageListener): void;
  removeEventListener(type: 'message', listener: KyMessageListener): void;
}

/** 握手状态机（§5.4）+ 两个终态：`standalone`（未嵌入）与 `failed`。 */
export type KyPhase =
  'loading' | 'attesting' | 'ready' | 'init' | 'active' | 'standalone' | 'failed';

/** 运行模式：壳内嵌入 vs 独立打开（本地开发与兜底登录页）。 */
export type KyMode = 'embedded' | 'standalone';

/** 诊断计数器（`app.getState().counters`）。 */
export interface KyCounters {
  /** `event.origin` 与壳 origin 不符而丢弃。 */
  droppedOrigin: number;
  /** `event.source !== window.parent` 而丢弃。 */
  droppedSource: number;
  /** `ns` 不是 `ky` 而丢弃（含 `ky-experimental`）。 */
  droppedNamespace: number;
  /** `v` 不是 1 而丢弃。 */
  droppedVersion: number;
  /** 不在壳→子消息表内而丢弃。 */
  droppedType: number;
  /** `ns:'ky-experimental'`（如 `context.set`）一律丢弃，单独计数。 */
  droppedExperimental: number;
  /** 重复 `(type,id)` 重放缓存应答的次数。 */
  replayedReplies: number;
  /** `ready` 重发次数。 */
  readyResends: number;
  /** 成功续期次数。 */
  refreshes: number;
  /** 续期失败次数（含超时与 `temporary`）。 */
  refreshFailures: number;
  /** 需应答消息 5 s 超时次数。 */
  requestTimeouts: number;
  /** `openLink()` 被本地校验拒绝的次数。 */
  blockedLinks: number;
  /** 401 后自动重放安全读请求的次数。 */
  authReplays: number;
  /** `X-KY-Perm-Version` 变化触发 `perm.changed` 的次数。 */
  permChanges: number;
}

export function createCounters(): KyCounters {
  return {
    droppedOrigin: 0,
    droppedSource: 0,
    droppedNamespace: 0,
    droppedVersion: 0,
    droppedType: 0,
    droppedExperimental: 0,
    replayedReplies: 0,
    readyResends: 0,
    refreshes: 0,
    refreshFailures: 0,
    requestTimeouts: 0,
    blockedLinks: 0,
    authReplays: 0,
    permChanges: 0,
  };
}

/** `app.getState()` 的返回。 */
export interface KyAppState {
  phase: KyPhase;
  mode: KyMode;
  installationId: string | null;
  /** SAT `exp`（秒级 epoch），与 `init.tokenExp` 同语义。 */
  tokenExp: number | null;
  shellOrigin: string | null;
  counters: KyCounters;
}

/** 应用层执行路由后的结果（§5.4 `route.result`）。 */
export interface KyRouteOutcome {
  ok: boolean;
  path?: string;
  reason?: 'not_found' | 'forbidden';
}

/** `onRoute` 的附加信息。 */
export interface KyRouteMeta {
  /** 壳侧导航 id，回声抑制用。 */
  navId?: string;
}

/** `openLink()` 的结果：本地校验拒绝时 `ok:false` 且带 `reason`。 */
export interface KyLinkOutcome {
  ok: boolean;
  reason?: KyLinkRejectReason;
}

export type KyLinkRejectReason =
  | 'not_https'
  | 'userinfo'
  | 'ip_host'
  | 'not_allowlisted'
  | 'invalid_url'
  | 'not_embedded'
  | 'shell_rejected'
  | 'timeout';

/** SDK 自身的错误信息（回调 `onError`）。 */
export interface KyErrorInfo {
  code: KyErrorCode;
  message: string;
}

export type KyErrorCode =
  | 'shell_origin_unknown'
  | 'attest_failed'
  | 'handshake_timeout'
  | 'contract_version_mismatch'
  | 'response_timeout'
  | 'destroyed';

/** `init` 载荷即子端拿到的会话上下文。 */
export type KyInitContext = InitPayload;

export interface KyAppOptions {
  /** 必须是 1；其他值直接拒绝（§8.3）。 */
  contractVersion?: 1;
  /** 安装证明端点，默认 `/ky/v1/attest`。 */
  attestUrl?: string;
  /** 注入的 `fetch`，默认全局 `fetch`。 */
  fetch?: typeof fetch;
  /** 注入的窗口，默认全局 `window`。 */
  window?: KyWindowLike;
  /** 注入的毫秒时钟，默认 `Date.now`。 */
  now?: () => number;
  /** 注入的定时器，默认全局 `setTimeout` / `clearTimeout`。 */
  timers?: KyTimers;
  /** 壳 origin；不传则取 `document.referrer` 的 origin。两者都没有 → 不发任何消息。 */
  shellOrigin?: string;
  /** 定制项目自身的 `KY_ORIGIN`；跨源请求不带令牌。 */
  appOrigin?: string;
  /** manifest `externalLinkHosts`，`openLink()` 的本地白名单。 */
  externalLinkHosts?: readonly string[];
  onInit?: (context: KyInitContext) => void;
  onRoute?: (path: string, meta: KyRouteMeta) => KyRouteOutcome | Promise<KyRouteOutcome>;
  onTheme?: (theme: string) => void;
  onVisibility?: (visible: boolean) => void;
  /** 终止性续期失败（客户面文案由应用层渲染，SDK 只给 reason）。 */
  onTokenError?: (reason: TokenRefreshErrorReason) => void;
  onPermChanged?: (permVersion: string) => void;
  onPhaseChange?: (phase: KyPhase) => void;
  onError?: (error: KyErrorInfo) => void;
}

/** `syncHistory()` 的模式：用户导航 `push`，初始化 / 重定向 / 回滚 `replace`（§5.2）。 */
export interface KySyncHistoryOptions {
  mode?: 'push' | 'replace';
  title?: string;
}

export interface KyApp {
  readonly contractVersion: 1;
  /** 带令牌的 `fetch` 包装。 */
  fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  /** 等待握手完成（`active` 或 `standalone`）；失败时 reject。 */
  ready: () => Promise<void>;
  getState: () => KyAppState;
  /** 应用层路由发生变化时上报（含 `navId` 回声抑制）。 */
  routeChanged: (path: string, title?: string) => void;
  /** `history.pushState` / `replaceState` + `route.changed` 的组合辅助。 */
  syncHistory: (path: string, options?: KySyncHistoryOptions) => void;
  openAgent: (input: AgentOpenPayload) => void;
  openLink: (url: string) => Promise<KyLinkOutcome>;
  toast: (input: ToastPayload) => void;
  requestLogout: () => void;
  permChanged: (permVersion: string) => void;
  destroy: () => void;
}
