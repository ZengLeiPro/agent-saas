import type { ContextIngestRecordInput, ContextObject } from '../../store/index.js';
import type {
  NormalizedTaskboardRecord,
  TaskboardBoardRow,
  TaskboardChangeRow,
  TaskboardTaskRow,
  TaskboardVisibility,
} from './types.js';

export function normalizeTaskboardBoard(board: TaskboardBoardRow, observedAt: string): NormalizedTaskboardRecord {
  const access = accessEnvelope(board.tenantId, board.ownerUserId, board.visibility);
  const data: ContextObject = {
    name: board.name,
    description: board.description ?? '',
    visibility: board.visibility,
    version: board.version,
    archived: Boolean(board.archivedAt),
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
    ...(board.archivedAt ? { archivedAt: board.archivedAt } : {}),
  };
  return {
    collection: 'projects',
    record: {
      recordId: `project:${board.id}`,
      externalRecordId: board.id,
      entityType: 'project',
      recordKind: 'snapshot',
      nativeId: board.id,
      ...access,
      content: data,
      metadata: { sourceKind: 'taskboard', boardId: board.id, ...access },
      sourceUpdatedAt: board.updatedAt,
      observedAt,
      evidence: [{
        evidenceId: 'native-locator',
        kind: 'native_locator',
        data: { sourceKind: 'taskboard', resourceType: 'board', nativeId: board.id },
      }],
    },
  };
}

export function normalizeTaskboardTask(task: TaskboardTaskRow, observedAt: string): NormalizedTaskboardRecord {
  const access = accessEnvelope(task.tenantId, task.ownerUserId, task.visibility);
  const data: ContextObject = {
    boardId: task.boardId,
    boardName: task.boardName,
    identifier: task.identifier,
    kind: task.kind,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    version: task.version,
    archived: Boolean(task.archivedAt),
    completed: Boolean(task.completedAt),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.dueAt ? { dueAt: task.dueAt } : {}),
    ...(task.creatorUserId ? { creatorUserId: task.creatorUserId } : {}),
    ...(task.creatorName ? { creatorName: task.creatorName } : {}),
    ...(task.archivedAt ? { archivedAt: task.archivedAt } : {}),
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(task.deletedAt ? { deletedAt: task.deletedAt } : {}),
  };
  return {
    collection: 'tasks',
    record: {
      recordId: `task:${task.id}`,
      externalRecordId: task.id,
      entityType: 'task',
      recordKind: 'snapshot',
      nativeId: task.id,
      ...access,
      content: data,
      metadata: { sourceKind: 'taskboard', boardId: task.boardId, ...access },
      deleted: Boolean(task.deletedAt),
      sourceUpdatedAt: task.updatedAt,
      observedAt,
      evidence: [{
        evidenceId: 'native-locator',
        kind: 'native_locator',
        data: {
          sourceKind: 'taskboard',
          resourceType: 'task',
          nativeId: task.id,
          boardId: task.boardId,
        },
      }],
    },
  };
}

export function normalizeTaskboardChange(change: TaskboardChangeRow, observedAt: string): NormalizedTaskboardRecord {
  const entityType = change.resourceType === 'board' ? 'project' : 'task';
  const access = accessEnvelope(change.tenantId, change.ownerUserId, change.visibility);
  const sourceEventId = `taskboard-change:${change.seq}`;
  return {
    collection: 'events',
    record: {
      recordId: sourceEventId,
      externalRecordId: sourceEventId,
      entityType,
      recordKind: 'event',
      nativeId: change.resourceId,
      sourceEventId,
      occurredAt: change.createdAt,
      ...access,
      content: {
        changeType: change.changeType,
        actorType: change.actorType,
        actorId: change.actorId,
        tombstone: change.tombstone,
      },
      metadata: { sourceKind: 'taskboard', changeSeq: change.seq, ...access },
      sourceUpdatedAt: change.createdAt,
      observedAt,
      evidence: [{
        evidenceId: `change-seq:${change.seq}`,
        kind: 'native_change_locator',
        data: {
          sourceKind: 'taskboard',
          resourceType: change.resourceType,
          nativeId: change.resourceId,
          seq: change.seq,
        },
      }],
    },
  };
}

export function normalizeDeletedTaskFallback(change: TaskboardChangeRow, observedAt: string): ContextIngestRecordInput {
  const access = accessEnvelope(change.tenantId, change.ownerUserId, change.visibility);
  return {
    recordId: `task:${change.resourceId}`,
    externalRecordId: change.resourceId,
    entityType: 'task',
    recordKind: 'snapshot',
    nativeId: change.resourceId,
    ...access,
    content: { deletedAt: change.createdAt },
    metadata: { sourceKind: 'taskboard', ...access },
    deleted: true,
    sourceUpdatedAt: change.createdAt,
    observedAt,
    evidence: [{
      evidenceId: `change-seq:${change.seq}`,
      kind: 'native_change_locator',
      data: {
        sourceKind: 'taskboard',
        resourceType: 'task',
        nativeId: change.resourceId,
        seq: change.seq,
      },
    }],
  };
}

function accessEnvelope(tenantId: string, ownerUserId: string, visibility: TaskboardVisibility): {
  ownerPrincipal: string;
  aclPrincipals: string[];
} {
  const ownerPrincipal = `user:${ownerUserId}`;
  return {
    ownerPrincipal,
    aclPrincipals: visibility === 'organization' ? [`org:${tenantId}`] : [ownerPrincipal],
  };
}
