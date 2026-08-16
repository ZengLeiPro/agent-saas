export type SessionGroupKind = 'manual' | 'cron' | 'taskboard';

export interface SessionGroup {
  id: string;
  userId: string;
  name: string;
  kind: SessionGroupKind;
  cronJobId?: string;
  taskboardId?: string;
  sessionIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface GroupsStoreFile {
  version: number;
  groups: SessionGroup[];
}

export interface CreateGroupInput {
  name: string;
  kind?: SessionGroupKind;
  cronJobId?: string;
  taskboardId?: string;
  sessionIds?: string[];
  userId: string;
}

export interface UpdateGroupInput {
  name?: string;
  sessionIds?: string[];
}

/** Internal-only patch fields (not exposed to API) */
export interface InternalGroupPatch extends UpdateGroupInput {
  kind?: SessionGroupKind;
  cronJobId?: string | undefined;
  taskboardId?: string | undefined;
  userId?: string;
}
