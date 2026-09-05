/**
 * §5.2 / §5.4 路由同步：
 * - 壳 → 子 `route.navigate{path}` + `navId` → 应用层 `onRoute(path)` → 回 `route.result`；
 * - 子 → 壳 `route.changed{path,title?}`，若这次变化正是刚刚那条导航的回声，携带同一 `navId`；
 * - `syncHistory()`：用户导航 `pushState`，初始化 / 重定向 / 回滚 `replaceState`。
 */
import { MESSAGE_NAMESPACE, MESSAGE_VERSION } from '@kaiyan/ky-app-contract';

import { toAppPath } from './environment.js';
import type { AnyEnvelope, Messenger } from './messenger.js';
import type { KyRouteOutcome, KySyncHistoryOptions, KyWindowLike, KyRouteMeta } from './types.js';

export interface RouterDeps {
  messenger: Messenger;
  window: KyWindowLike;
  /** 相对路径解析基准。 */
  baseHref: string;
  onRoute?: (path: string, meta: KyRouteMeta) => KyRouteOutcome | Promise<KyRouteOutcome>;
}

export class Router {
  readonly #deps: RouterDeps;
  /** 最近一次壳发起的导航，等待应用层的 `route.changed` 回声。 */
  #pendingEcho: { navId: string; path: string } | null = null;

  constructor(deps: RouterDeps) {
    this.#deps = deps;
  }

  /** 处理 `route.navigate`，返回 `route.result` 信封。 */
  async handleNavigate(envelope: AnyEnvelope): Promise<AnyEnvelope> {
    const raw = (envelope.payload as { path?: unknown } | undefined)?.path;
    const navId = typeof envelope.navId === 'string' ? envelope.navId : undefined;
    if (typeof raw !== 'string' || raw === '') {
      return this.#result({ ok: false, reason: 'not_found' }, envelope.id, navId);
    }
    const path = toAppPath(raw, this.#deps.baseHref);
    const handler = this.#deps.onRoute;
    if (handler === undefined) {
      return this.#result({ ok: false, reason: 'not_found' }, envelope.id, navId);
    }
    const outcome = await handler(path, { ...(navId === undefined ? {} : { navId }) });
    const resultPath =
      typeof outcome.path === 'string' ? toAppPath(outcome.path, this.#deps.baseHref) : path;
    if (outcome.ok && navId !== undefined) {
      this.#pendingEcho = { navId, path: resultPath };
    }
    return this.#result(
      { ...outcome, ...(outcome.ok ? { path: resultPath } : {}) },
      envelope.id,
      navId,
    );
  }

  /** 应用层路由变化后上报；命中回声时携带同一 `navId`（回声抑制）。 */
  routeChanged(path: string, title?: string): void {
    const normalized = toAppPath(path, this.#deps.baseHref);
    let navId: string | undefined;
    if (this.#pendingEcho !== null && this.#pendingEcho.path === normalized) {
      navId = this.#pendingEcho.navId;
      this.#pendingEcho = null;
    }
    this.#deps.messenger.post(
      'route.changed',
      { path: normalized, ...(title === undefined ? {} : { title }) },
      navId === undefined ? undefined : { navId },
    );
  }

  /** `history` 写入 + `route.changed` 上报。 */
  syncHistory(path: string, options?: KySyncHistoryOptions): void {
    const normalized = toAppPath(path, this.#deps.baseHref);
    const history = this.#deps.window.history;
    if (history !== undefined) {
      if ((options?.mode ?? 'push') === 'push') history.pushState({}, '', normalized);
      else history.replaceState({}, '', normalized);
    }
    this.routeChanged(normalized, options?.title);
  }

  #result(payload: KyRouteOutcome, id: unknown, navId: string | undefined): AnyEnvelope {
    return {
      ns: MESSAGE_NAMESPACE,
      v: MESSAGE_VERSION,
      type: 'route.result',
      ...(typeof id === 'string' ? { id } : {}),
      ...(navId === undefined ? {} : { navId }),
      payload,
    };
  }
}
