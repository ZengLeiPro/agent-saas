import type { SessionMeta } from "../data/transcripts/meta.js";
import { canAccessSession, type SessionAccessUser } from "../data/sessions/access.js";
import type { UserStore } from "../data/users/store.js";
import { apiLogger } from "../utils/logger.js";

export type TaskboardSessionReadAuthorizer = (user: {
  userId: string;
  username: string;
  role: "admin" | "user";
  tenantId: string;
}, sessionId: string) => Promise<boolean>;

export async function canReadSessionDetail(
  user: SessionAccessUser | undefined,
  meta: SessionMeta | null,
  sessionId: string,
  userStore?: UserStore,
  authorizeTaskboardSession?: TaskboardSessionReadAuthorizer,
): Promise<boolean> {
  if (canAccessSession(user, meta, userStore)) return true;
  if (!user || meta?.sessionSource !== "taskboard_execution" || !authorizeTaskboardSession) return false;
  try {
    return await authorizeTaskboardSession({
      userId: user.sub,
      username: user.username,
      role: user.role,
      tenantId: user.tenantId,
    }, sessionId);
  } catch (error) {
    apiLogger.warn(`[sessions] taskboard session read authorization failed sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
