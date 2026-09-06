/**
 * WP2a：当前用户可见的定制项目安装实例（`GET /api/systems/mine`，规范 §8.1）。
 *
 * 可见性完全由服务端计算（本组织 + 分配命中 + 系统曾发布），前端不做任何二次过滤，
 * 也不缓存跨会话结果。**停用的实例服务端也会返回**（带 `state`），因为 §5.5/§6.6
 * 要求标签保留在侧边栏并显示《系统名》+「暂不可用」，而不是整项消失。
 * 走 `authFetch` 而不是裸 `fetch`：分域部署下的 baseUrl 与令牌刷新都由它收口
 * （`web/scripts/check-api-boundary.mjs` 的约束）。
 */
import { authFetch } from '@/lib/authFetch';

/**
 * 壳可见的实例状态（服务端 `KyAppMineState` 的镜像，闭集）。
 * §5.5 /§6.6：停用与 `live` 失败**不把标签从侧边栏拿掉**，而是留在原位标「暂不可用」。
 */
export const MY_SYSTEM_STATES = [
  'enabled',
  'disabled',
  'unavailable',
  'maintenance',
  'needs_reregistration',
] as const;
export type MySystemState = (typeof MY_SYSTEM_STATES)[number];

const STATE_SET = new Set<string>(MY_SYSTEM_STATES);

/** 壳渲染定制项目标签所需的最小字段。 */
export interface MySystemInstallation {
  installationId: string;
  systemId: string;
  name: string;
  icon: string | null;
  origin: string;
  /**
   * 服务端算好的状态。**不要把它折叠成布尔** —— `disabled`/`unavailable` 是
   * 「标签保留 + 暂不可用」，`maintenance`/`needs_reregistration` 是「条幅 + 可重试」，
   * 客户面文案不同（§6.6）。
   */
  state: MySystemState;
  /** manifest 的 `externalLinkHosts`（§5.4 `link.open` 白名单）；缺省空数组 = fail-closed。 */
  externalLinkHosts: string[];
}

/** 能不能真的进这个系统（挂 iframe）。其余状态一律只渲染标签与文案。 */
export function isSystemOpenable(installation: MySystemInstallation): boolean {
  return installation.state === 'enabled';
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
    // 未知/缺失的 state 回落 `unavailable` 而不是 `enabled`：新增状态时宁可
    // 让标签停在「暂不可用」，也不要让壳去挂一个服务端已经不认的实例。
    state: typeof record.state === 'string' && STATE_SET.has(record.state)
      ? (record.state as MySystemState)
      : 'unavailable',
    externalLinkHosts: Array.isArray(record.externalLinkHosts)
      ? record.externalLinkHosts
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item !== '')
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
