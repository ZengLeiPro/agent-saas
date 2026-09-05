/**
 * 子端运行环境的读取：`ky` / `ky_iid` / `ky_nonce` 保留参数、当前应用路径规范化、
 * 壳 origin 推导（§5.2 / §5.3）。
 */
import { RESERVED_QUERY_PARAMS, normalizeAppPath } from '@kaiyan/ky-app-contract/browser';

import type { KyWindowLike } from './types.js';

export interface KyLocationInfo {
  /** `ky=1` 才算嵌入在壳内。 */
  embedded: boolean;
  installationId: string | null;
  nonce: string | null;
  /** 当前文档 origin，用于 `fetch` 包装的同源判断。 */
  origin: string;
  /** 规范化后的应用路径（已剔除 `ky`/`ky_iid`/`ky_nonce`）。 */
  path: string;
}

const [KY_FLAG, KY_IID, KY_NONCE] = RESERVED_QUERY_PARAMS;

/** 读取 `location`：保留参数 + 规范化后的当前路径。 */
export function readLocation(href: string): KyLocationInfo {
  const url = new URL(href);
  return {
    embedded: url.searchParams.get(KY_FLAG) === '1',
    installationId: url.searchParams.get(KY_IID),
    nonce: url.searchParams.get(KY_NONCE),
    origin: url.origin,
    path: appPathFromUrl(url),
  };
}

/**
 * 用 contract 的 `normalizeAppPath()` 把当前 URL 规范化成 `ready.path`。
 *
 * 规范化函数对 `%2f`/`%2e`/`//`/`..` 一律拒绝（fail-closed），而查询串里出现这些字面量
 * 并不罕见；这里逐级降级：完整路径 → 仅 pathname → `/`，绝不因为一个查询参数把握手打断。
 */
export function appPathFromUrl(url: URL): string {
  for (const candidate of [`${url.pathname}${url.search}${url.hash}`, url.pathname]) {
    try {
      return normalizeAppPath(candidate);
    } catch {
      continue;
    }
  }
  return '/';
}

/** 供应用层直接规范化字符串路径，同样逐级降级。 */
export function toAppPath(path: string, base: string): string {
  try {
    return normalizeAppPath(path);
  } catch {
    return appPathFromUrl(new URL(path, base));
  }
}

/**
 * 壳 origin：优先 `options.shellOrigin`，否则取 `document.referrer` 的 origin。
 * 两者都拿不到返回 `null` —— 调用方据此不发任何消息并报错（§5.3 精确 targetOrigin）。
 */
export function resolveShellOrigin(explicit: string | undefined, win: KyWindowLike): string | null {
  const candidates = [explicit, win.document?.referrer];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    try {
      const origin = new URL(candidate).origin;
      if (origin && origin !== 'null') return origin;
    } catch {
      continue;
    }
  }
  return null;
}

/** 取全局 `window`（Node 下不存在时返回 undefined，交由调用方报错）。 */
export function globalWindow(): KyWindowLike | undefined {
  const candidate = (globalThis as { window?: unknown }).window;
  return candidate === undefined ? undefined : (candidate as KyWindowLike);
}
