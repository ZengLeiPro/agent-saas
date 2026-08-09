import type { UserStore } from '../data/users/store.js';

type ModelResolver = (ref: string, tenantId?: string) => unknown | null;

export function createTaskboardRuntimeOptions(params: {
  modelResolver?: ModelResolver;
  userStore?: UserStore;
  timezone?: string;
  logger: { warn(message: string): void };
}) {
  return {
    resolveModel: params.modelResolver
      ? (ref: string, tenantId?: string) => params.modelResolver?.(ref, tenantId) ? { ref } : null
      : undefined,
    resolveUserDisplayName: (userId: string) => {
      try {
        params.userStore?.reload();
      } catch (error) {
        params.logger.warn(
          `Taskboard user display name reload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const user = params.userStore?.findById(userId);
      if (!user) return undefined;
      return user.realName ? `${user.realName} @${user.username}` : user.username;
    },
    timezone: params.timezone,
  };
}
