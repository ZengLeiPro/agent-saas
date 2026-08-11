export type DirectoryGroupSource = 'dingtalk' | 'governance';
export type DirectoryGroupStatus = 'active' | 'disabled';

export interface DirectoryGroup {
  groupId: string;
  tenantId: string;
  source: DirectoryGroupSource;
  externalGroupId?: string;
  displayName: string;
  parentGroupId?: string;
  status: DirectoryGroupStatus;
  version: number;
  sourceRevision?: string;
  projectedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DirectoryGroupMember {
  tenantId: string;
  groupId: string;
  userId: string;
  source: DirectoryGroupSource;
  version: number;
}

export interface UpsertDirectoryGroupProjectionInput {
  groupId: string;
  tenantId: string;
  source: DirectoryGroupSource;
  externalGroupId?: string;
  displayName: string;
  parentGroupId?: string;
  status: DirectoryGroupStatus;
  memberUserIds: string[];
  sourceRevision?: string;
}
