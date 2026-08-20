import type { TaskBoardAttachment, TaskBoardUploadAttachment } from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from '../taskboard/types.js';
import type { TaskboardIdentity } from '../taskboard/types.js';
import type {
  TaskboardActionScope,
  TaskboardAttachmentInput,
  TaskboardToolOptions,
} from './taskboardToolActions.js';

/** task.update 的附件输入采用追加语义；兼容旧任务时保留其原始附件记录。 */
export function appendTaskboardAttachments(
  existing: readonly TaskBoardAttachment[] | undefined,
  additions: readonly TaskBoardUploadAttachment[] | undefined,
): TaskBoardUploadAttachment[] | undefined {
  if (!additions?.length) return undefined;
  return [...(existing ?? []), ...additions] as TaskBoardUploadAttachment[];
}

export async function materializeTaskboardAttachments(
  options: TaskboardToolOptions,
  identity: TaskboardIdentity,
  taskId: string,
  ownerUserId: string | undefined,
  attachments: TaskBoardUploadAttachment[] | undefined,
): Promise<TaskBoardUploadAttachment[] | undefined> {
  if (attachments === undefined) return undefined;
  if (attachments.length === 0) return [];
  if (!ownerUserId || !options.materializeTaskAttachments) {
    throw new TaskboardValidationError(
      'Taskboard task-scope attachment service is unavailable',
      'TASKBOARD_ATTACHMENT_UNAVAILABLE',
    );
  }
  try {
    return await options.materializeTaskAttachments(identity, taskId, ownerUserId, attachments);
  } catch (error) {
    if (error instanceof TaskboardValidationError) throw error;
    throw new TaskboardValidationError(
      error instanceof Error ? error.message : 'Failed to materialize attachment',
      'TASKBOARD_ATTACHMENT_MATERIALIZATION_FAILED',
    );
  }
}

export async function resolveTaskboardAttachments(
  options: TaskboardToolOptions,
  identity: TaskboardIdentity,
  attachments: TaskboardAttachmentInput[] | undefined,
  scope: TaskboardActionScope,
): Promise<TaskBoardUploadAttachment[] | undefined> {
  if (attachments === undefined) return undefined;
  if (attachments.length === 0) return [];
  if (!scope.sessionId) {
    throw new TaskboardValidationError(
      'Taskboard attachment session context is required',
      'TASKBOARD_ATTACHMENT_SESSION_REQUIRED',
    );
  }
  if (!options.resolveAttachments) {
    throw new TaskboardValidationError(
      'Taskboard attachment resolver is unavailable',
      'TASKBOARD_ATTACHMENT_UNAVAILABLE',
    );
  }
  try {
    const resolved = await options.resolveAttachments(
      identity,
      attachments.map((attachment) => attachment.attachmentId),
      { sessionId: scope.sessionId },
    );
    if (resolved.length !== attachments.length || resolved.some(
      (attachment, index) => attachment.attachmentId !== attachments[index]!.attachmentId,
    )) {
      throw new Error('Attachment resolver returned an unexpected attachment set');
    }
    return resolved;
  } catch (error) {
    if (error instanceof TaskboardValidationError) throw error;
    throw new TaskboardValidationError(
      error instanceof Error ? error.message : 'Invalid attachment',
      'TASKBOARD_INVALID_ATTACHMENT',
    );
  }
}

export async function cleanupTaskboardAttachments(
  options: TaskboardToolOptions,
  identity: TaskboardIdentity,
  taskId: string,
  ownerUserId: string | undefined,
  attachments: readonly TaskBoardUploadAttachment[] | undefined,
  existing: readonly TaskBoardAttachment[] = [],
): Promise<void> {
  if (!attachments?.length || !ownerUserId || !options.cleanupTaskAttachments) return;
  const existingKeys = new Set(existing.map((attachment) => `${attachment.attachmentId}:${attachment.relativePath}`));
  const created = attachments.filter((attachment) => !existingKeys.has(`${attachment.attachmentId}:${attachment.relativePath}`));
  if (created.length) await options.cleanupTaskAttachments(identity, taskId, ownerUserId, created);
}
