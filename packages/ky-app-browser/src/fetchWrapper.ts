/**
 * §5.5 `fetch` 包装：
 * - 自动带 `Authorization: Bearer <SAT>`，仅同源相对路径或 `KY_ORIGIN` 同源；跨源不带；
 * - `init` 之前不发（排队到 `active`），`standalone` 直发且不带令牌；
 * - 401 → 单飞续期 → 只自动重放安全读请求（GET/HEAD）**一次**；写请求不重放，抛
 *   `KyAuthError` 交页面用幂等键处理；
 * - 响应头 `X-KY-Perm-Version` 变化 → `perm.changed`（§3.4 权限版本发现）。
 */
import { HTTP_HEADERS } from '@kaiyan/ky-app-contract/browser';

import { KyAuthError } from './errors.js';
import type { TokenManager } from './tokenManager.js';
import type { KyCounters, KyMode } from './types.js';

export interface KyFetchDeps {
  fetchImpl: typeof fetch;
  tokens: TokenManager;
  mode: KyMode;
  /** 等待握手完成；reject 表示握手失败。 */
  waitReady: () => Promise<void>;
  /** 当前文档 origin。 */
  documentOrigin: string;
  /** 定制项目自身的 `KY_ORIGIN`（可与文档 origin 不同）。 */
  appOrigin?: string;
  /** 相对路径解析基准。 */
  baseHref: string;
  counters: KyCounters;
  onPermVersion: (permVersion: string) => void;
}

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export function createKyFetch(
  deps: KyFetchDeps,
): (input: string | URL, init?: RequestInit) => Promise<Response> {
  const readPermVersion = (response: Response): void => {
    const value = response.headers?.get?.(HTTP_HEADERS.permVersion);
    if (typeof value === 'string' && value !== '') deps.onPermVersion(value);
  };

  const sameSecurityContext = (target: URL): boolean =>
    target.origin === deps.documentOrigin ||
    (deps.appOrigin !== undefined && target.origin === deps.appOrigin);

  return async function kyFetch(input: string | URL, init?: RequestInit): Promise<Response> {
    const target = new URL(typeof input === 'string' ? input : input.toString(), deps.baseHref);
    const href = target.toString();

    if (deps.mode === 'standalone') {
      // 本地开发与兜底登录页：不握手、不带令牌，直接透传。
      const response = await deps.fetchImpl(href, init);
      readPermVersion(response);
      return response;
    }

    try {
      await deps.waitReady();
    } catch (error) {
      throw new KyAuthError(
        'handshake_failed',
        `握手未完成，请求未发出：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!sameSecurityContext(target)) {
      const response = await deps.fetchImpl(href, init);
      readPermVersion(response);
      return response;
    }

    const token = await deps.tokens.ensureFresh();
    const first = await deps.fetchImpl(href, withAuthorization(init, token));
    readPermVersion(first);
    if (first.status !== 401) return first;

    const outcome = await deps.tokens.refresh();
    if (!outcome.ok) {
      throw new KyAuthError(outcome.reason, '401 后续期失败，需要重新登录', first);
    }
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!SAFE_METHODS.has(method)) {
      // 写请求绝不自动重放：可能已经落库。页面自己用同一幂等键查询 / 重试。
      throw new KyAuthError('unauthorized', '写请求返回 401，请用同一幂等键自行重试', first);
    }
    const snapshot = deps.tokens.store.read();
    if (snapshot === null) throw new KyAuthError('no_token', '续期后仍无可用令牌', first);
    deps.counters.authReplays += 1;
    const second = await deps.fetchImpl(href, withAuthorization(init, snapshot.token));
    readPermVersion(second);
    return second;
  };
}

/**
 * 合并请求头并覆盖 `Authorization`。
 * 用 `[name, value][]` 而不是 `Headers`，避免依赖运行环境是否提供 `Headers` 构造器。
 */
export function withAuthorization(init: RequestInit | undefined, token: string): RequestInit {
  const merged: [string, string][] = [];
  for (const [name, value] of headerEntries(init?.headers)) {
    if (name.toLowerCase() === 'authorization') continue;
    merged.push([name, value]);
  }
  merged.push(['Authorization', `Bearer ${token}`]);
  return { ...init, headers: merged };
}

function headerEntries(headers: RequestInit['headers']): [string, string][] {
  if (headers === undefined || headers === null) return [];
  if (Array.isArray(headers)) return headers.map(([name, value]) => [name, value]);
  const iterable = headers as { forEach?: (fn: (value: string, name: string) => void) => void };
  if (typeof iterable.forEach === 'function') {
    const entries: [string, string][] = [];
    iterable.forEach((value, name) => entries.push([name, value]));
    return entries;
  }
  return Object.entries(headers as Record<string, string>);
}
