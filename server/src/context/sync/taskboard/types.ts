import type { ContextIngestRecordInput, ContextJson, ContextObject } from '../../store/index.js';

export const TASKBOARD_SOURCE_ID = 'taskboard';
export const TASKBOARD_SOURCE_KIND = 'taskboard';
export const TASKBOARD_PARTITION_KEY = 'tenant';

export const TASKBOARD_COLLECTIONS = {
  projects: {
    collectionId: 'taskboard-projects',
    externalKey: 'taskboard-projects',
    displayName: 'Taskboard projects',
  },
  tasks: {
    collectionId: 'taskboard-tasks',
    externalKey: 'taskboard-tasks',
    displayName: 'Taskboard tasks',
  },
  events: {
    collectionId: 'taskboard-events',
    externalKey: 'taskboard-events',
    displayName: 'Taskboard events',
  },
} as const;

export type TaskboardCollectionKind = keyof typeof TASKBOARD_COLLECTIONS;
export type TaskboardEntityType = 'project' | 'task';
export type TaskboardVisibility = 'personal' | 'organization';

export interface TaskboardBoardRow {
  id: string;
  tenantId: string;
  ownerUserId: string;
  name: string;
  description?: string;
  visibility: TaskboardVisibility;
  version: number;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskboardTaskRow {
  id: string;
  tenantId: string;
  boardId: string;
  boardName: string;
  ownerUserId: string;
  visibility: TaskboardVisibility;
  identifier: string;
  kind: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  labels: string[];
  dueAt?: string;
  creatorUserId?: string;
  creatorName?: string;
  version: number;
  archivedAt?: string;
  deletedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskboardChangeRow {
  seq: string;
  tenantId: string;
  resourceType: 'board' | 'task';
  resourceId: string;
  changeType: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string;
  tombstone: boolean;
  createdAt: string;
  ownerUserId: string;
  visibility: TaskboardVisibility;
}

export interface TaskboardPage<T> {
  items: T[];
  nextCursor?: string;
}

/** Local compatibility shape until the shared typed context envelope is available. */
export interface TaskboardContextEnvelope {
  schemaVersion: 1;
  sourceKind: 'taskboard';
  recordKind: 'snapshot' | 'event';
  entityType: TaskboardEntityType;
  nativeId: string;
  ownerPrincipal: string;
  aclPrincipals: string[];
  data: ContextObject;
  sourceEventId?: string;
  occurredAt?: string;
}

export interface NormalizedTaskboardRecord {
  collection: TaskboardCollectionKind;
  record: ContextIngestRecordInput;
}

export interface TaskboardRunResult {
  tenantId: string;
  skipped: boolean;
  inventoryBoards: number;
  inventoryTasks: number;
  changes: number;
  snapshots: number;
  events: number;
  watermark: string;
}

export function envelopeAsContextJson(envelope: TaskboardContextEnvelope): ContextJson {
  return envelope as unknown as ContextJson;
}
