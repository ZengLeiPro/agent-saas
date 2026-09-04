import type { SessionDetailAccessMode } from "@agent/shared";
import type { SessionMeta } from "../data/transcripts/meta.js";
import { canAccessSession, type SessionAccessUser } from "../data/sessions/access.js";
import type { UserStore } from "../data/users/store.js";
import { apiLogger } from "../utils/logger.js";

/** 仅判断请求人能否通过关联任务获得跨用户只读权限。 */
export type TaskboardSessionReadAuthorizer = (user: {
  userId: string;
  username: string;
  role: "admin" | "user";
  tenantId: string;
}, sessionId: string) => Promise<boolean>;

export async function resolveSessionDetailAccess(
  user: SessionAccessUser | undefined,
  meta: SessionMeta | null,
  sessionId: string,
  userStore?: UserStore,
  authorizeTaskboardSession?: TaskboardSessionReadAuthorizer,
): Promise<SessionDetailAccessMode | null> {
  if (canAccessSession(user, meta, userStore)) return "owner";
  if (!user || meta?.deletedAt || meta?.sessionSource !== "taskboard_execution" || !authorizeTaskboardSession) return null;
  try {
    return await authorizeTaskboardSession({
      userId: user.sub,
      username: user.username,
      role: user.role,
      tenantId: user.tenantId,
    }, sessionId) ? "read_only" : null;
  } catch (error) {
    apiLogger.warn(`[sessions] taskboard session read authorization failed sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
