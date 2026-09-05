/**
 * `createKyApp()` —— 子端 SDK 主入口（§5 全部）。
 *
 * 装配：环境读取 → 信封收发（Messenger）→ 握手状态机（Handshake）→ 令牌单飞续期
 * （TokenManager）→ `fetch` 包装 → 路由同步（Router）→ 其余子→壳 API。
 *
 * 没有 `ky=1` 时进入 `standalone`：不握手、不发任何消息、`fetch` 不带令牌，
 * 供本地开发与兜底登录页复用。
 */
import {
  AGENT_OPEN_PROMPT_MAX_LENGTH,
  CONTRACT_VERSION,
  TOAST_MESSAGE_MAX_LENGTH,
  type AgentOpenPayload,
  type InitPayload,
  type ThemeChangedPayload,
  type ToastPayload,
  type TokenRefreshErrorPayload,
  type TokenRefreshPayload,
  type VisibilityPayload,
} from '@kaiyan/ky-app-contract';

import { globalWindow, readLocation, resolveShellOrigin } from './environment.js';
import { KyUsageError } from './errors.js';
import { createKyFetch } from './fetchWrapper.js';
import { Handshake } from './handshake.js';
import { checkExternalLink } from './links.js';
import { Messenger } from './messenger.js';
import { Router } from './routing.js';
import { TokenManager } from './tokenManager.js';
import {
  createCounters,
  defaultTimers,
  type KyApp,
  type KyAppOptions,
  type KyAppState,
  type KyErrorInfo,
  type KyLinkOutcome,
  type KyMode,
  type KyPhase,
  type KySyncHistoryOptions,
} from './types.js';

const TOAST_LEVELS: ReadonlySet<string> = new Set(['info', 'success', 'warning', 'error']);
/** 默认安装证明端点（§4.6）。 */
export const DEFAULT_ATTEST_URL = '/ky/v1/attest';

export function createKyApp(options: KyAppOptions = {}): KyApp {
  if ((options.contractVersion ?? CONTRACT_VERSION) !== CONTRACT_VERSION) {
    throw new KyUsageError(`本 SDK 只实现 contractVersion=${String(CONTRACT_VERSION)}`);
  }
  const win = options.window ?? globalWindow();
  if (win === undefined) {
    throw new KyUsageError('没有可用的 window：@kaiyan/ky-app-browser 只能在浏览器环境运行');
  }

  const timers = options.timers ?? defaultTimers;
  const now = options.now ?? (() => Date.now());
  const counters = createCounters();
  const location = readLocation(win.location.href);
  const mode: KyMode = location.embedded ? 'embedded' : 'standalone';
  const shellOrigin = mode === 'embedded' ? resolveShellOrigin(options.shellOrigin, win) : null;

  let phase: KyPhase = mode === 'standalone' ? 'standalone' : 'loading';
  let lastPermVersion: string | null = null;
  let destroyed = false;

  const emitError = (info: KyErrorInfo): void => {
    options.onError?.(info);
  };
  const setPhase = (next: KyPhase): void => {
    phase = next;
    options.onPhaseChange?.(next);
  };

  const messenger = new Messenger({
    window: win,
    shellOrigin,
    timers,
    counters,
    onHandlerError: (type, error) => {
      emitError({
        code: 'response_timeout',
        message: `处理 ${type} 时抛错：${error instanceof Error ? error.message : String(error)}`,
      });
    },
  });

  const tokens = new TokenManager({
    messenger,
    timers,
    counters,
    now,
    onTokenError: (reason) => options.onTokenError?.(reason),
  });

  const router = new Router({
    messenger,
    window: win,
    baseHref: win.location.href,
    ...(options.onRoute === undefined ? {} : { onRoute: options.onRoute }),
  });

  const fetchImpl: typeof fetch =
    options.fetch ??
    ((input, init) => {
      const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
      if (globalFetch === undefined) {
        return Promise.reject(new KyUsageError('当前环境没有 fetch，请通过 options.fetch 注入'));
      }
      return globalFetch(input, init);
    });

  // 未嵌入 / 拿不到壳 origin 时，握手不启动；ready() 分别是「立即完成」与「立即失败」。
  let handshake: Handshake | null = null;
  let readyPromise: Promise<void>;

  if (mode === 'standalone') {
    readyPromise = Promise.resolve();
  } else if (shellOrigin === null) {
    // §5.3 精确 targetOrigin：拿不到壳 origin 就一条消息都不发。
    const message =
      '无法确定壳 origin（document.referrer 为空且未传 options.shellOrigin），不发送任何消息';
    setPhase('failed');
    emitError({ code: 'shell_origin_unknown', message });
    readyPromise = Promise.reject(new KyUsageError(message));
    readyPromise.catch(() => undefined);
  } else if (location.installationId === null || location.nonce === null) {
    const message = '壳注入的 ky_iid / ky_nonce 缺失，无法请求安装证明';
    setPhase('failed');
    emitError({ code: 'attest_failed', message });
    readyPromise = Promise.reject(new KyUsageError(message));
    readyPromise.catch(() => undefined);
  } else {
    handshake = new Handshake({
      messenger,
      tokens,
      timers,
      counters,
      now,
      fetchImpl,
      attestUrl: options.attestUrl ?? DEFAULT_ATTEST_URL,
      installationId: location.installationId,
      nonce: location.nonce,
      path: location.path,
      onPhase: setPhase,
      onInit: (context: InitPayload) => options.onInit?.(context),
      onError: emitError,
    });
    readyPromise = handshake.waitReady();
  }

  const notifyPermVersion = (permVersion: string): void => {
    if (permVersion === lastPermVersion) return;
    lastPermVersion = permVersion;
    counters.permChanges += 1;
    messenger.post('perm.changed', { permVersion });
    options.onPermChanged?.(permVersion);
  };

  const kyFetch = createKyFetch({
    fetchImpl,
    tokens,
    mode,
    waitReady: () => readyPromise,
    documentOrigin: location.origin,
    ...(options.appOrigin === undefined ? {} : { appOrigin: options.appOrigin }),
    baseHref: win.location.href,
    counters,
    onPermVersion: notifyPermVersion,
  });

  registerHandlers();
  messenger.start();
  if (handshake !== null) void handshake.start();

  function registerHandlers(): void {
    if (handshake !== null) {
      messenger.on('init', (envelope) => handshake?.handleInit(envelope));
    }
    messenger.on('route.navigate', (envelope) => router.handleNavigate(envelope));
    messenger.on('theme.changed', (envelope) => {
      const payload = envelope.payload as ThemeChangedPayload | undefined;
      if (payload !== undefined) options.onTheme?.(payload.theme);
      return undefined;
    });
    messenger.on('visibility', (envelope) => {
      const payload = envelope.payload as VisibilityPayload | undefined;
      if (payload === undefined) return undefined;
      options.onVisibility?.(payload.visible);
      // §5.4 表注：回前台先确保令牌有效。
      if (payload.visible) tokens.onVisible();
      return undefined;
    });
    messenger.on('token.refresh', (envelope, context) => {
      if (context.matchedPending) return undefined;
      const payload = envelope.payload as TokenRefreshPayload | undefined;
      if (payload !== undefined) tokens.accept(payload);
      return undefined;
    });
    messenger.on('token.refresh.error', (envelope, context) => {
      if (context.matchedPending) return undefined;
      const payload = envelope.payload as TokenRefreshErrorPayload | undefined;
      if (payload !== undefined) tokens.handleErrorPush(payload);
      return undefined;
    });
  }

  function getState(): KyAppState {
    return {
      phase,
      mode,
      installationId: location.installationId,
      tokenExp: tokens.store.tokenExp,
      shellOrigin,
      counters: { ...counters },
    };
  }

  function openAgent(input: AgentOpenPayload): void {
    const payload: AgentOpenPayload = {};
    if (input.prompt !== undefined) {
      payload.prompt = clampText(input.prompt, AGENT_OPEN_PROMPT_MAX_LENGTH, 'agent.open prompt');
    }
    if (input.context !== undefined) {
      const entity = input.context.entity as
        { type?: unknown; id?: unknown; label?: unknown } | undefined;
      if (
        entity === undefined ||
        typeof entity.type !== 'string' ||
        typeof entity.id !== 'string' ||
        typeof entity.label !== 'string'
      ) {
        throw new KyUsageError('context.entity 必须含 type / id / label 三个字符串字段');
      }
      payload.context = {
        entity: {
          type: entity.type,
          id: entity.id,
          label: clampText(entity.label, AGENT_OPEN_PROMPT_MAX_LENGTH, 'entity.label'),
        },
        ...(input.context.summary === undefined
          ? {}
          : {
              summary: clampText(
                input.context.summary,
                AGENT_OPEN_PROMPT_MAX_LENGTH,
                'context.summary',
              ),
            }),
      };
    }
    messenger.post('agent.open', payload);
  }

  async function openLink(url: string): Promise<KyLinkOutcome> {
    const check = checkExternalLink(url, options.externalLinkHosts ?? []);
    if (!check.ok) {
      // 本地校验不通过：直接拒绝，不发消息。
      counters.blockedLinks += 1;
      return { ok: false, ...(check.reason === undefined ? {} : { reason: check.reason }) };
    }
    try {
      const reply = await messenger.request('link.open', { url: check.url });
      const ok = (reply.payload as { ok?: unknown } | undefined)?.ok === true;
      return ok ? { ok: true } : { ok: false, reason: 'shell_rejected' };
    } catch {
      return { ok: false, reason: mode === 'embedded' ? 'timeout' : 'not_embedded' };
    }
  }

  function toast(input: ToastPayload): void {
    if (!TOAST_LEVELS.has(input.level)) {
      throw new KyUsageError('toast.level 只能是 info / success / warning / error');
    }
    messenger.post('toast', {
      level: input.level,
      message: clampText(input.message, TOAST_MESSAGE_MAX_LENGTH, 'toast.message'),
    });
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    handshake?.destroy();
    tokens.destroy();
    messenger.destroy();
  }

  return {
    contractVersion: CONTRACT_VERSION,
    fetch: kyFetch,
    ready: () => readyPromise,
    getState,
    routeChanged: (path: string, title?: string) => router.routeChanged(path, title),
    syncHistory: (path: string, syncOptions?: KySyncHistoryOptions) =>
      router.syncHistory(path, syncOptions),
    openAgent,
    openLink,
    toast,
    requestLogout: () => {
      messenger.post('logout.request');
    },
    permChanged: (permVersion: string) => {
      messenger.post('perm.changed', { permVersion });
    },
    destroy,
  };
}

/** 纯文本裁剪：剔除控制字符，按码点截断到上限并告警（§5.4 ≤ 500 / ≤ 200）。 */
export function clampText(value: string, max: number, label: string): string {
  if (typeof value !== 'string') throw new KyUsageError(`${label} 必须是字符串`);
  const plain = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  const points = Array.from(plain);
  if (points.length <= max) return plain;
  console.warn(`[ky-app] ${label} 超过 ${String(max)} 字，已截断`);
  return points.slice(0, max).join('');
}
