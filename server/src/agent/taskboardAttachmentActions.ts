import type { TaskBoardUploadAttachment } from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from '../taskboard/types.js';
import type { TaskboardIdentity } from '../taskboard/types.js';
import type {
  TaskboardActionScope,
  TaskboardAttachmentInput,
  TaskboardToolOptions,
} from './taskboardToolActions.js';

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
