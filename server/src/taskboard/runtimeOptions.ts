import type { UserStore } from '../data/users/store.js';

type ModelResolver = (ref: string, tenantId?: string) => unknown | null;

export function createTaskboardRuntimeOptions(params: {
  modelResolver?: ModelResolver;
  userStore?: UserStore;
  timezone?: string;
  logger: { warn(message: string): void };
}) {
  const loadUser = (userId: string) => {
    try {
      params.userStore?.reload();
    } catch (error) {
      params.logger.warn(
        `Taskboard user reload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return params.userStore?.findById(userId);
  };

  return {
    resolveModel: params.modelResolver
      ? (ref: string, tenantId?: string) => params.modelResolver?.(ref, tenantId) ? { ref } : null
      : undefined,
    resolveOwnerIdentity: (userId: string) => {
      const user = loadUser(userId);
      if (!user || user.disabled) return undefined;
      return {
        tenantId: user.tenantId,
        ownerUserId: user.id,
        username: user.username,
        displayName: user.realName ? `${user.realName} @${user.username}` : user.username,
        userRole: user.role,
      };
    },
    resolveUserDisplayName: (userId: string) => {
      const user = loadUser(userId);
      if (!user) return undefined;
      return user.realName ? `${user.realName} @${user.username}` : user.username;
    },
    timezone: params.timezone,
  };
}
