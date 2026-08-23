import { describe, expect, it } from 'vitest';

import {
  normalizeTaskboardBoard,
  normalizeTaskboardChange,
  normalizeTaskboardTask,
} from './normalizer.js';
import type { TaskboardBoardRow, TaskboardChangeRow, TaskboardTaskRow } from './types.js';

const NOW = '2026-08-23T06:00:00.000Z';

function board(overrides: Partial<TaskboardBoardRow> = {}): TaskboardBoardRow {
  return {
    id: 'board-1', tenantId: 'tenant-a', ownerUserId: 'owner-1', name: 'Product',
    description: 'Roadmap', visibility: 'organization', version: 2,
    createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function task(overrides: Partial<TaskboardTaskRow> = {}): TaskboardTaskRow {
  return {
    id: 'task-1', tenantId: 'tenant-a', boardId: 'board-1', boardName: 'Product',
    ownerUserId: 'owner-1', visibility: 'personal', identifier: 'PROD-1', kind: 'delivery',
    title: 'Ship', description: 'Release it', status: 'todo', priority: 'high', labels: ['release'],
    version: 3, createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

it('maps boards and tasks to typed snapshots with native ownership and ACL', () => {
  const project = normalizeTaskboardBoard(board(), NOW).record;
  expect(project).toMatchObject({
    entityType: 'project', recordKind: 'snapshot', nativeId: 'board-1',
    ownerPrincipal: 'user:owner-1', aclPrincipals: ['org:tenant-a'],
  });
  expect(project.evidence).toEqual([expect.objectContaining({
    kind: 'native_locator', data: expect.objectContaining({ nativeId: 'board-1', resourceType: 'board' }),
  })]);

  const item = normalizeTaskboardTask(task({ archivedAt: NOW }), NOW).record;
  expect(item).toMatchObject({
    entityType: 'task', recordKind: 'snapshot', nativeId: 'task-1',
    ownerPrincipal: 'user:owner-1', aclPrincipals: ['user:owner-1'], deleted: false,
    content: expect.objectContaining({ archived: true }),
  });
});

it('maps a change to an append-only event with source sequence evidence', () => {
  const change: TaskboardChangeRow = {
    seq: '42', tenantId: 'tenant-a', resourceType: 'task', resourceId: 'task-1',
    changeType: 'task.updated', actorType: 'user', actorId: 'user-2', tombstone: false,
    createdAt: NOW, ownerUserId: 'owner-1', visibility: 'organization',
  };
  expect(normalizeTaskboardChange(change, NOW).record).toMatchObject({
    recordId: 'taskboard-change:42', externalRecordId: 'taskboard-change:42',
    entityType: 'task', recordKind: 'event', nativeId: 'task-1',
    sourceEventId: 'taskboard-change:42', occurredAt: NOW,
    evidence: [{ evidenceId: 'change-seq:42', data: expect.objectContaining({ seq: '42' }) }],
  });
});

it('never copies prompt, repository credentials, execution ids, or arbitrary change payloads', () => {
  const unsafeBoard = { ...board(), prompt: 'SECRET_PROMPT', repository: { token: 'SECRET_TOKEN' } };
  const unsafeTask = { ...task(), executionSecret: 'SECRET_EXECUTION' };
  const unsafeChange = {
    seq: '9', tenantId: 'tenant-a', resourceType: 'board', resourceId: 'board-1',
    changeType: 'board.updated', actorType: 'system', actorId: 'system', tombstone: false,
    createdAt: NOW, ownerUserId: 'owner-1', visibility: 'personal',
    payload: { credential: 'SECRET_CREDENTIAL' }, executionId: 'SECRET_EXECUTION_ID',
  } as const;
  const serialized = JSON.stringify([
    normalizeTaskboardBoard(unsafeBoard, NOW),
    normalizeTaskboardTask(unsafeTask, NOW),
    normalizeTaskboardChange(unsafeChange, NOW),
  ]);
  expect(serialized).not.toMatch(/SECRET_|prompt|repository|credential|executionId/);
});
