import { createHash } from 'node:crypto';

import type { TaskBoardTaskKind } from '../../../shared/src/types/taskboard.js';
import type { TaskboardActionScope, TaskboardManageInput } from './taskboardToolActions.js';

export function taskboardCreateRequestDigest(
  input: TaskboardManageInput,
  kind: TaskBoardTaskKind,
): string {
  return createHash('sha256').update(JSON.stringify({
    boardId: input.boardId,
    title: input.title,
    description: input.description,
    kind,
    dispatch: input.dispatch === true,
    branch: input.branch,
    attachments: input.attachments?.map((attachment) => attachment.attachmentId),
    status: input.status,
    priority: input.priority,
    labels: input.labels,
    dueAt: input.dueAt,
    model: input.model,
  })).digest('hex');
}

export function taskboardCreateRequestId(
  input: TaskboardManageInput,
  scope: TaskboardActionScope,
  kind: TaskBoardTaskKind,
): string {
  const sourceRunId = scope.execution?.execution.runId ?? 'unknown-run';
  return `taskboard-tool:${sourceRunId.slice(-64)}:${taskboardCreateRequestDigest(input, kind).slice(0, 32)}`;
}
