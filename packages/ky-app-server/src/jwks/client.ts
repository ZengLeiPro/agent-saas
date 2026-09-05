/**
 * §3.1-5 JWKS 客户端。
 *
 * 自建而不用 `jose.createRemoteJWKSet`，因为契约要求：未知 `kid` 单飞重拉一次、
 * 负缓存 60 s（LRU ≤ 1000）、全局重拉 ≤ 1 次 / 10 s、拉取失败 stale-if-error 24 h、
 * `jwks.revoke` 立即失效。`fetch` 与时钟均可注入，供测试与 doctor 使用。
 */
import { importJWK, type CryptoKey, type JWK } from 'jose';

import { JWKS } from '@kaiyan/ky-app-contract';

import { KyAppError } from '../errors.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JwksClientOptions {
  /** 按 `KY_ENV` 固定；local/test 允许注入（见 config 模块）。 */
  url: string;
  fetch?: FetchLike;
  /** 毫秒时钟，默认 `Date.now`。 */
  now?: () => number;
}

export interface JwksClient {
  /** 取 `kid` 对应的验签公钥；未知 / 已撤销 / 超 24 h fail-closed 时抛 401。 */
  getKey(kid: string): Promise<CryptoKey>;
  /** `jwks.rotated`：预取新 `kid`（失败只吞掉，不影响主流程）。 */
  prefetch(kid?: string): Promise<void>;
  /** `jwks.revoke`：立即失效并清负缓存（§3.7）。 */
  revoke(kid: string): void;
  /** 当前缓存中的 `kid` 列表，用于 `health/ready` 的 `jwksKids`。 */
  kids(): string[];
}

interface JwksState {
  keys: Map<string, CryptoKey>;
  /** 最近一次**成功**拉取的时刻（毫秒）；null 表示从未成功过。 */
  lastSuccessAt: number | null;
  /** 最近一次发起拉取的时刻（毫秒），用于全局 ≤ 1 次 / 10 s 节流。 */
  lastAttemptAt: number | null;
  /** kid → 负缓存失效时刻（毫秒），插入序即 LRU 序。 */
  negative: Map<string, number>;
  /** 被 `jwks.revoke` 撤销的 kid：即使 JWKS 里仍在，也永不再用（fail-closed）。 */
  revoked: Set<string>;
  inflight: Promise<void> | null;
}

function unknownKid(kid: string): KyAppError {
  return new KyAppError('unauthorized', { message: `未知的 JWKS kid：${kid}` });
}

/** JWKS 文档解析：≤ 16 KB、拒重定向、`kty=EC / crv=P-256 / use=sig`、`kid` 唯一。 */
export async function parseJwksResponse(response: Response): Promise<Map<string, JWK>> {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    throw new Error('JWKS 响应发生重定向');
  }
  if (!response.ok) throw new Error(`JWKS 响应状态 ${response.status}`);
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > JWKS.maxBytes) {
    throw new Error(`JWKS 响应超过 ${JWKS.maxBytes} 字节`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > JWKS.maxBytes) {
    throw new Error(`JWKS 响应超过 ${JWKS.maxBytes} 字节`);
  }
  const document = JSON.parse(text) as { keys?: unknown };
  if (!Array.isArray(document.keys)) throw new Error('JWKS 缺少 keys 数组');

  const result = new Map<string, JWK>();
  for (const entry of document.keys) {
    if (typeof entry !== 'object' || entry === null) throw new Error('JWKS 条目不是对象');
    const jwk = entry as JWK;
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.use !== 'sig') {
      throw new Error('JWKS 只接受 kty=EC / crv=P-256 / use=sig');
    }
    if (typeof jwk.kid !== 'string' || jwk.kid === '') throw new Error('JWKS 条目缺少 kid');
    if (result.has(jwk.kid)) throw new Error(`JWKS kid 重复：${jwk.kid}`);
    result.set(jwk.kid, jwk);
  }
  return result;
}

/** 创建 JWKS 客户端。 */
export function createJwksClient(options: JwksClientOptions): JwksClient {
  const now = options.now ?? Date.now;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const state: JwksState = {
    keys: new Map(),
    lastSuccessAt: null,
    lastAttemptAt: null,
    negative: new Map(),
    revoked: new Set(),
    inflight: null,
  };

  function rememberNegative(kid: string): void {
    state.negative.delete(kid);
    state.negative.set(kid, now() + JWKS.negativeCacheSeconds * 1000);
    while (state.negative.size > JWKS.negativeCacheMaxEntries) {
      const oldest = state.negative.keys().next();
      if (oldest.done === true) break;
      state.negative.delete(oldest.value);
    }
  }

  function negativeHit(kid: string): boolean {
    const until = state.negative.get(kid);
    if (until === undefined) return false;
    if (until <= now()) {
      state.negative.delete(kid);
      return false;
    }
    return true;
  }

  async function fetchOnce(): Promise<void> {
    state.lastAttemptAt = now();
    const response = await doFetch(options.url, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
    const jwks = await parseJwksResponse(response);
    const keys = new Map<string, CryptoKey>();
    for (const [kid, jwk] of jwks) {
      if (state.revoked.has(kid)) continue;
      keys.set(kid, (await importJWK(jwk, 'ES256')) as CryptoKey);
    }
    state.keys = keys;
    state.lastSuccessAt = now();
  }

  /**
   * 单飞重拉：并发调用共享同一个 promise；全局 ≤ 1 次 / 10 s，
   * 被节流时直接返回（不抛错），由调用方按 stale-if-error 决定。
   */
  async function refresh(): Promise<void> {
    if (state.inflight !== null) return state.inflight;
    const last = state.lastAttemptAt;
    if (last !== null && now() - last < JWKS.refetchMinIntervalMs) return;
    const inflight = fetchOnce().catch(() => {
      // 拉取失败不向上抛：由 stale-if-error / fail-closed 分支统一决策。
    });
    state.inflight = inflight;
    try {
      await inflight;
    } finally {
      state.inflight = null;
    }
  }

  function staleUsable(): boolean {
    return (
      state.lastSuccessAt !== null && now() - state.lastSuccessAt <= JWKS.staleIfErrorSeconds * 1000
    );
  }

  return {
    async getKey(kid: string): Promise<CryptoKey> {
      if (state.revoked.has(kid)) throw unknownKid(kid);
      if (negativeHit(kid)) throw unknownKid(kid);

      const cached = state.keys.get(kid);
      const fresh =
        state.lastSuccessAt !== null && now() - state.lastSuccessAt <= JWKS.maxAgeSeconds * 1000;
      if (cached !== undefined && fresh) return cached;

      await refresh();

      const after = state.keys.get(kid);
      if (after !== undefined) {
        // 拿到 key 但快照可能是 24 h 前的：超窗一律 fail-closed。
        if (!staleUsable()) {
          throw new KyAppError('unauthorized', {
            message: 'JWKS 已超过 24 小时无法刷新，fail-closed',
          });
        }
        return after;
      }

      // 只有在「确实有过成功快照且其中没有这个 kid」时才写负缓存；
      // 从未拉成功过时不写，避免网络故障把合法 kid 钉死 60 s。
      if (state.lastSuccessAt !== null) rememberNegative(kid);
      throw unknownKid(kid);
    },

    async prefetch(kid?: string): Promise<void> {
      if (kid !== undefined) state.negative.delete(kid);
      // 轮换预取属于事件驱动，绕过 10 s 节流。
      state.lastAttemptAt = null;
      await refresh();
    },

    revoke(kid: string): void {
      state.revoked.add(kid);
      state.keys.delete(kid);
      state.negative.clear();
    },

    kids(): string[] {
      return [...state.keys.keys()];
    },
  };
}
