import type { TaskBoardTask } from '../../../shared/src/types/taskboard.js';
import {
  readSessionMeta,
  updateSessionMeta,
} from '../data/transcripts/meta.js';
import type { TaskboardExecutionStore } from './types.js';

export interface TaskboardSessionTitleUpdate {
  ownerUserId: string;
  sessionId: string;
  title: string;
}

export interface TaskboardSessionTitleWriterInput {
  store: Pick<TaskboardExecutionStore, 'getExecutionContextBySessionId'>;
  sessionId: string;
  transcriptPath: string;
}

export type TaskboardSessionTitleWriter = (
  input: TaskboardSessionTitleWriterInput,
) => Promise<TaskboardSessionTitleUpdate | null>;

export function formatTaskboardSessionTitle(
  task: Pick<TaskBoardTask, 'identifier' | 'title'>,
): string {
  return `${task.identifier.trim()} ${task.title.trim()}`.trim();
}

export const writeTaskboardSessionTitle: TaskboardSessionTitleWriter = async ({
  store,
  sessionId,
  transcriptPath,
}) => {
  const context = await store.getExecutionContextBySessionId(sessionId);
  if (!context) throw new Error(`任务看板会话上下文不存在：${sessionId}`);

  const title = formatTaskboardSessionTitle(context.task);
  const current = await readSessionMeta(transcriptPath);
  if (!current) throw new Error(`任务看板会话元数据不存在：${sessionId}`);
  if (current.generatedTitle === title) return null;

  const updated = await updateSessionMeta(transcriptPath, { generatedTitle: title });
  if (!updated) throw new Error(`任务看板会话标题写入失败：${sessionId}`);
  return {
    ownerUserId: context.identity.ownerUserId,
    sessionId,
    title: updated.customTitle || title,
  };
};
