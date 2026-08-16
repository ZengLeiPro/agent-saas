import type { UserStore } from '../data/users/store.js';
import type { EventStore } from '../runtime/types.js';
import type { TaskboardSessionGroupingOptions } from './sessionGrouping.js';

type ModelResolver = (ref: string, tenantId?: string) => unknown | null;
type SessionGroupedEvent = Parameters<NonNullable<TaskboardSessionGroupingOptions['onSessionGrouped']>>[0];

export function createTaskboardRuntimeOptions(params: {
  modelResolver?: ModelResolver;
  userStore?: UserStore;
  timezone?: string;
  logger: { warn(message: string): void };
  eventStore?: Pick<EventStore, 'append'>;
  groupTaskboardSession?: TaskboardSessionGroupingOptions['groupTaskboardSession'];
  onSessionsChanged?: () => void;
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
    groupTaskboardSession: params.groupTaskboardSession,
    onSessionTitleUpdated: params.onSessionsChanged,
    onSessionGrouped: params.onSessionsChanged ? async (event: SessionGroupedEvent) => {
      params.onSessionsChanged?.();
      if (!params.eventStore) return;
      const tenantId = loadUser(event.userId)?.tenantId;
      await params.eventStore.append({
        type: 'session_group_changed',
        sessionId: event.sessionId,
        userId: event.userId,
        groupId: event.groupId,
      }, tenantId ? { tenantId } : undefined);
    } : undefined,
    timezone: params.timezone,
  };
}
