import type { SessionMeta } from "../transcripts/meta.js";
import { PLATFORM_TENANT_ID } from "../tenants/types.js";
import type { UserStore } from "../users/store.js";

export interface SessionAccessUser {
  sub: string;
  username: string;
  role: "admin" | "user";
  tenantId: string;
}

/**
 * 是否平台管理员（pantheon 租户 admin）。**用于系统内部会话/任务的可见性**——
 * 组织管理员（其他租户的 admin）不视为平台管理员。
 */
export function isPlatformAdminUser(
  reqUser: { role: "admin" | "user"; tenantId?: string } | undefined,
): boolean {
  return !!reqUser && reqUser.role === "admin" && reqUser.tenantId === PLATFORM_TENANT_ID;
}

/**
 * 会话访问守门：任何身份（包括平台 admin / 组织 admin）都只能访问自己的会话。
 */
export function canAccessSession(
  reqUser: SessionAccessUser | undefined,
  meta: SessionMeta | null | undefined,
  _userStore?: UserStore,
): boolean {
  if (!reqUser || !meta) return false;
  return meta.userId === reqUser.sub;
}

/**
 * 记忆/心跳轮询会话判断：与 cron.ts/groups.ts 的 isMemoryPollJob 对齐。
 * 平台内部系统任务，除平台管理员外一律不可见。
 * 真源是 meta.cronSystemKind（2026-07-14 systemKind 批次）；
 * 名称后缀匹配仅作存量人工创建任务的兼容。
 */
export function isMemoryPollSessionMeta(
  meta: SessionMeta | null | undefined,
): boolean {
  if (!meta) return false;
  if (meta.cronSystemKind === "memory_poll") return true;
  const jobName = meta.cronJobName;
  if (!jobName) return false;
  return jobName.endsWith("记忆轮询") || jobName.endsWith("心跳轮询");
}

/**
 * 记忆/心跳轮询会话对当前请求方是否应被隐藏。
 * 2026-07-14 曾磊拍板 B 方案：**只有平台管理员（pantheon 租户 admin）能看到**——
 * 组织管理员看到自己的会话/系统任务在产品心智上模糊了「平台内部基础设施」的边界，
 * 因此与普通用户一起隐藏。历史"心跳轮询"沿用同一规则。
 */
export function hidesMemoryPollFrom(
  reqUser: { role: "admin" | "user"; tenantId?: string } | undefined,
  meta: SessionMeta | null | undefined,
): boolean {
  if (!isMemoryPollSessionMeta(meta)) return false;
  return !isPlatformAdminUser(reqUser);
}

/** L2 记忆整合是内部审计会话，不进入普通会话 API，平台管理员改从 Run Trace 查看。 */
export function hidesSystemSessionFrom(
  reqUser: { role: "admin" | "user"; tenantId?: string } | undefined,
  meta: SessionMeta | null | undefined,
): boolean {
  if (meta?.sessionSource === "memory_consolidation"
    || meta?.profileBindingKey === "memory_consolidate") return true;
  // 独立 memory_consolidate Profile 上线前，L2 曾复用 memory_poll binding；
  // 真正的 L3 cron 轮询有 cronSystemKind/cronJobName，可据此避免误伤平台管理员审计入口。
  if (meta?.profileBindingKey === "memory_poll" && !isMemoryPollSessionMeta(meta)) return true;
  return hidesMemoryPollFrom(reqUser, meta);
}

export function canExposeSessionToUser(
  reqUser: SessionAccessUser | undefined,
  meta: SessionMeta | null | undefined,
  userStore?: UserStore,
): boolean {
  if (!canAccessSession(reqUser, meta, userStore)) return false;
  if (meta?.deletedAt) return false;
  if (hidesSystemSessionFrom(reqUser, meta)) return false;
  return true;
}
