import type { SessionMeta } from "../transcripts/meta.js";
import type { UserStore } from "../users/store.js";

export interface SessionAccessUser {
  sub: string;
  username: string;
  role: "admin" | "user";
  tenantId: string;
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
 * 非 admin 不应通过列表、详情或搜索感知这些内部会话。
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

export function canExposeSessionToUser(
  reqUser: SessionAccessUser | undefined,
  meta: SessionMeta | null | undefined,
  userStore?: UserStore,
): boolean {
  if (!canAccessSession(reqUser, meta, userStore)) return false;
  if (meta?.deletedAt) return false;
  if (reqUser?.role !== "admin" && isMemoryPollSessionMeta(meta)) return false;
  return true;
}
