export interface SessionGroup {
  id: string;
  userId: string;
  name: string;
  kind: 'manual' | 'cron';
  cronJobId?: string;
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
  kind?: 'manual' | 'cron';
  cronJobId?: string;
  sessionIds?: string[];
  userId: string;
}

export interface UpdateGroupInput {
  name?: string;
  sessionIds?: string[];
}

/** Internal-only patch fields (not exposed to API) */
export interface InternalGroupPatch extends UpdateGroupInput {
  kind?: 'manual' | 'cron';
  cronJobId?: string | undefined;
  userId?: string;
}
