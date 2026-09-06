/**
 * WP2a：当前用户可见的定制项目安装实例（`GET /api/systems/mine`，规范 §8.1）。
 *
 * 可见性完全由服务端计算（本组织 + `enabled` + 分配命中 + 系统已发布），
 * 前端不做任何二次过滤，也不缓存跨会话结果。
 * 走 `authFetch` 而不是裸 `fetch`：分域部署下的 baseUrl 与令牌刷新都由它收口
 * （`web/scripts/check-api-boundary.mjs` 的约束）。
 */
import { authFetch } from '@/lib/authFetch';

/** 壳渲染定制项目标签所需的最小字段。 */
export interface MySystemInstallation {
  installationId: string;
  systemId: string;
  name: string;
  icon: string | null;
  origin: string;
  state: 'enabled';
  /**
   * manifest 的 `externalLinkHosts`（§5.4 `link.open` 白名单）。
   * **服务端当前不返回这个字段**（`/api/systems/mine` 只给壳渲染标签的最小字段），
   * 所以它现在恒为空数组 → 壳侧外链一律 fail-closed。见偏差 4-B-01：
   * 需要 WP2a 在 mine.ts 里补一行才能真正放行外链。
   */
  externalLinkHosts: string[];
}

export interface MySystemsResponse {
  installations: MySystemInstallation[];
}

function asInstallation(value: unknown): MySystemInstallation | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const installationId = record.installationId;
  const systemId = record.systemId;
  const origin = record.origin;
  if (typeof installationId !== 'string' || installationId === '') return null;
  if (typeof systemId !== 'string' || systemId === '') return null;
  if (typeof origin !== 'string' || origin === '') return null;
  return {
    installationId,
    systemId,
    name: typeof record.name === 'string' && record.name !== '' ? record.name : systemId,
    icon: typeof record.icon === 'string' && record.icon !== '' ? record.icon : null,
    origin,
    state: 'enabled',
    externalLinkHosts: Array.isArray(record.externalLinkHosts)
      ? record.externalLinkHosts.filter((item): item is string => typeof item === 'string')
      : [],
  };
}

/**
 * 拉取当前用户可见的安装实例。
 * 未启用定制项目对接时服务端不注册该路由，会返回 404——按「没有可见系统」处理，
 * 不向用户报错（壳只是不显示第二个标签）。
 */
export async function fetchMySystems(): Promise<MySystemsResponse> {
  const response = await authFetch('/api/systems/mine');
  if (response.status === 404) return { installations: [] };
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: string; code?: string };
    } | null;
    const error = new Error(body?.error?.message ?? `HTTP ${response.status}`);
    Object.assign(error, { status: response.status, code: body?.error?.code });
    throw error;
  }
  const payload = (await response.json().catch(() => null)) as { installations?: unknown } | null;
  const list = Array.isArray(payload?.installations) ? payload.installations : [];
  const installations: MySystemInstallation[] = [];
  for (const item of list) {
    const parsed = asInstallation(item);
    if (parsed) installations.push(parsed);
  }
  return { installations };
}
