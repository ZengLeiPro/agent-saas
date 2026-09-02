// 模块级预加载：在 JS 加载时立即发起 API 请求，
// 消除 auth → sessions → detail 的串行瀑布。
// auth 请求带重试逻辑，确保后端就绪后再继续后续预取。

import { apiUrl } from "./apiBase";
import { DEFAULT_TENANT_ID } from "@agent/shared";
import type { TenantFeatureFlags, UserPreferences } from "@agent/shared";
import { TOKEN_KEY } from "./constants";
import { AUTH_SESSION_KEY } from '@agent/shared';

function currentAuthHeaders(): HeadersInit {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// --- Auth 预取（带重试，等待后端就绪） ---

export type AuthPreloadResult =
  | { status: "authenticated"; user: { id: string; username: string; role: "admin" | "user"; tenantId: string; tenantName?: string; isSuperAdmin?: boolean; realName?: string; position?: string; phone?: string; phoneVerifiedAt?: string; avatar?: string; avatarVersion?: number; debugMode?: boolean; tenantFeatures?: TenantFeatureFlags; preferences?: UserPreferences } }
  | { status: "no-auth" }
  | { status: "unauthenticated" }
  | { status: "error" };

const AUTH_MAX_RETRIES = 10;
const AUTH_BASE_DELAY = 500;
const AUTH_MAX_DELAY = 8000;
const AUTH_BACKOFF_FACTOR = 1.5;

function getRetryDelay(attempt: number): number {
  const delay = Math.min(AUTH_BASE_DELAY * AUTH_BACKOFF_FACTOR ** attempt, AUTH_MAX_DELAY);
  return delay + delay * 0.3 * Math.random(); // 30% jitter
}

async function fetchAuth(): Promise<AuthPreloadResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(apiUrl("/api/auth/me"), { headers: currentAuthHeaders() });
      if (res.ok) {
        const refreshedToken = res.headers.get('X-Refresh-Token');
        const authEpoch = Number(res.headers.get('X-Auth-Epoch'));
        const generation = Number(res.headers.get('X-Auth-Generation'));
        if (refreshedToken) {
          try {
            localStorage.setItem(TOKEN_KEY, refreshedToken);
            if (Number.isSafeInteger(authEpoch) && authEpoch > 0 && Number.isSafeInteger(generation) && generation > 0) {
              localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify({ authEpoch, generation }));
            }
          } catch {
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(AUTH_SESSION_KEY);
            return { status: 'unauthenticated' };
          }
        }
        const data = await res.json() as { id: string; username: string; role: "admin" | "user"; tenantId: string; tenantName?: string; isSuperAdmin?: boolean; realName?: string; position?: string; phone?: string; phoneVerifiedAt?: string; avatar?: string; avatarVersion?: number; debugMode?: boolean; tenantFeatures?: TenantFeatureFlags; preferences?: UserPreferences };
        return { status: "authenticated", user: data };
      }
      if (res.status === 404) {
        return { status: "no-auth" };
      }
      // 5xx: 后端尚在启动中（Vite 代理返回 500、反代返回 502/503 等），重试
      if (res.status >= 500 && attempt < AUTH_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, getRetryDelay(attempt)));
        continue;
      }
      return { status: "unauthenticated" };
    } catch {
      // 网络错误（ECONNREFUSED 等），后端未就绪，重试
      if (attempt < AUTH_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, getRetryDelay(attempt)));
        continue;
      }
      return { status: "error" };
    }
  }
}

export const authPreload: Promise<AuthPreloadResult> = fetchAuth();

// --- Sessions 预取（链在 authPreload 之后，确保后端已就绪） ---

export const sessionsPreload: Promise<{ sessions: unknown[]; hasMore: boolean } | null> = authPreload.then((result) => {
  if (result.status === "unauthenticated" || result.status === "error") return null;
  return fetch(apiUrl("/api/sessions?limit=500&fresh=1"), { headers: currentAuthHeaders(), cache: "no-store" })
    .then(async (res) => {
      if (res.ok) {
        const data = await res.json();
        return { sessions: data.sessions || [], hasMore: data.hasMore ?? false };
      }
      return null;
    })
    .catch(() => null);
});

// --- Users 延迟预取（auth 后等 2 秒再发起，避免与首屏请求竞争带宽） ---

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const usersPreload: Promise<unknown[] | null> = authPreload.then(async (result) => {
  if (result.status === "authenticated" && result.user.role === "admin") {
    await delay(2000);
    return fetch(apiUrl("/api/auth/users"), { headers: currentAuthHeaders() })
      .then(async (r) => (r.ok ? ((await r.json()).users || []) : null))
      .catch(() => null);
  }
  return null;
});

// 仅平台 admin 预取组织列表（普通 admin / 组织 admin 后端会 403）
export const tenantsPreload: Promise<unknown[] | null> = authPreload.then(async (result) => {
  if (
    result.status === "authenticated" &&
    result.user.role === "admin" &&
    result.user.tenantId === DEFAULT_TENANT_ID
  ) {
    await delay(2000);
    return fetch(apiUrl("/api/tenants"), { headers: currentAuthHeaders() })
      .then(async (r) => (r.ok ? ((await r.json()).tenants || []) : null))
      .catch(() => null);
  }
  return null;
});
