/**
 * 壳侧握手三端点（WP2a 已交付，规范 §5.4-3、§3.1）。
 *
 * 对应 `shell.html:165-187`（mock 壳的 `/shell/api/nonce`、`/shell/api/token`）与
 * `:273-287`（`/shell/api/verify`）。真实壳走 agent-saas 自己的端点，
 * 全部经 `authFetch`（分域 baseUrl 与会话续期都由它收口，`check-api-boundary` 也要求）。
 *
 * **子 iframe 永远拿不到壳会话 JWT**：这三个端点用壳会话鉴权，返回的 `token` 是
 * `act=user` 的 SAT，是唯一允许下发给子端的凭据。
 */
import { authFetch } from '@/lib/authFetch';
import type { TokenRefreshErrorReason } from '@kaiyan/ky-app-contract/browser';

const BASE = '/api/app-contract/v1/installations';

export interface HandshakeNonce {
  nonce: string;
  expiresAt: string;
}

/** 服务端 `KyAppHandshakeResult`：`init` 载荷里除 theme/locale 之外的全部字段。 */
export interface HandshakeGrant {
  token: string;
  tokenExp: number;
  user: { id: string; displayName: string; isTenantAdmin: boolean };
  installationId: string;
  contractVersion: number;
}

export class AppHostApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'AppHostApiError';
  }
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const response = await authFetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new AppHostApiError(
      parsed?.error?.message ?? `HTTP ${response.status}`,
      response.status,
      parsed?.error?.code ?? null,
    );
  }
  return (await response.json()) as T;
}

export function requestHandshakeNonce(installationId: string): Promise<HandshakeNonce> {
  return post<HandshakeNonce>(`${BASE}/${encodeURIComponent(installationId)}/handshake/nonce`);
}

export function verifyHandshake(
  installationId: string,
  input: { nonce: string; attestation: string },
): Promise<HandshakeGrant> {
  return post<HandshakeGrant>(
    `${BASE}/${encodeURIComponent(installationId)}/handshake/verify`,
    input,
  );
}

export function refreshUserToken(installationId: string): Promise<HandshakeGrant> {
  return post<HandshakeGrant>(`${BASE}/${encodeURIComponent(installationId)}/token`);
}

/**
 * 续期失败 → §5.4 的四个 reason。
 *
 * WP2a 的错误码与这四个 reason 不是一一对应（见偏差 4-B-02）：
 * SAT 签发被拒（用户停用 / 成员停用 / authEpoch 失效）统一是 `forbidden`，
 * 壳只能按「不是会话过期、也不是实例停用，那就是这个人不能用了」归口到 `user_disabled`。
 * 归错的后果是文案不够精确，而不是把不该放行的放行 —— 四个 reason 都会让子端停下来。
 */
export function refreshErrorReason(error: unknown): TokenRefreshErrorReason {
  if (!(error instanceof AppHostApiError)) return 'temporary';
  if (error.status === 401) return 'session_expired';
  if (error.code === 'installation_disabled') return 'installation_disabled';
  if (error.code === 'not_found') return 'installation_disabled';
  if (error.status === 403) return 'user_disabled';
  if (error.status >= 500 || error.status === 429) return 'temporary';
  return 'temporary';
}

/** §5.2：壳 URL → iframe `src`，注入 `ky` / `ky_iid` / `ky_nonce`（保留 baseUrl 原有 query）。 */
export function buildFrameSrc(input: {
  origin: string;
  appPath: string;
  installationId: string;
  nonce: string;
}): string {
  const url = new URL(input.appPath || '/', input.origin);
  url.searchParams.set('ky', '1');
  url.searchParams.set('ky_iid', input.installationId);
  url.searchParams.set('ky_nonce', input.nonce);
  return url.toString();
}
