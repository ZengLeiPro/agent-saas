import type { AppRuntime } from "./runtime.js";
import type { TaskboardSessionReadAuthorizer } from "../routes/taskboardSessionReadAccess.js";

export function createTaskboardSessionReadAuthorizer(
  store: AppRuntime["taskboardExecutionStore"],
): TaskboardSessionReadAuthorizer {
  return async (user, sessionId) => {
    if (!store) return false;
    const context = await store.getExecutionContextBySessionId(sessionId);
    if (!context || context.identity.tenantId !== user.tenantId) return false;
    try {
      await store.getTask({
        tenantId: user.tenantId,
        ownerUserId: user.userId,
        username: user.username,
        userRole: user.role,
      }, context.task.id);
      return true;
    } catch {
      return false;
    }
  };
}
