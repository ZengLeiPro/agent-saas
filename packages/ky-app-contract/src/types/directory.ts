/** 附录 L / §3.6：组织目录快照与变更流。 */

export type DirectoryStatus = 'active' | 'disabled';

export interface DirectoryUser {
  userId: string;
  displayName: string;
  employeeNo?: string;
  status: DirectoryStatus;
  isTenantAdmin: boolean;
  groupIds: string[];
}

export interface DirectoryGroup {
  groupId: string;
  displayName: string;
  parentGroupId?: string | null;
  status: DirectoryStatus;
}

export interface DirectorySnapshot {
  snapshotSeq: number;
  /** 签名 opaque，封装 {tid, snapshotSeq, page, exp=10min}。 */
  pageToken?: string;
  users: DirectoryUser[];
  groups: DirectoryGroup[];
}

export type DirectoryEventType = 'user.upsert' | 'user.remove' | 'group.upsert' | 'group.remove';

interface DirectoryEventBase {
  seq: number;
  eventId: string;
}

export interface DirectoryUserUpsertEvent extends DirectoryEventBase {
  type: 'user.upsert';
  user: DirectoryUser;
}

export interface DirectoryUserRemoveEvent extends DirectoryEventBase {
  type: 'user.remove';
  userId: string;
}

export interface DirectoryGroupUpsertEvent extends DirectoryEventBase {
  type: 'group.upsert';
  group: DirectoryGroup;
}

export interface DirectoryGroupRemoveEvent extends DirectoryEventBase {
  type: 'group.remove';
  groupId: string;
}

export type DirectoryEvent =
  | DirectoryUserUpsertEvent
  | DirectoryUserRemoveEvent
  | DirectoryGroupUpsertEvent
  | DirectoryGroupRemoveEvent;

export interface DirectoryChanges {
  events: DirectoryEvent[];
  nextSeq: number;
  hasMore: boolean;
}

/** 服务凭据 scope（§3.6）。 */
export const DIRECTORY_CREDENTIAL_SCOPES = ['snapshot', 'changes', 'credential-ack'] as const;
export type DirectoryCredentialScope = (typeof DIRECTORY_CREDENTIAL_SCOPES)[number];
