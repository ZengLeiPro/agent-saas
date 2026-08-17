import type {
  TaskBoardExecutionPurpose,
  TaskBoardTask,
} from '../../../shared/src/types/taskboard.js';
import {
  readSessionMeta,
  updateSessionMeta,
} from '../data/transcripts/meta.js';
import type { TaskboardExecutionStore } from './types.js';

/** 任务看板执行阶段的中文标签：work=实施、review=复核、merge=合并。 */
export const TASKBOARD_PURPOSE_LABELS: Record<TaskBoardExecutionPurpose, string> = {
  work: '实施',
  review: '复核',
  merge: '合并',
};

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

/**
 * 生成任务看板会话标题。
 *
 * 格式为「任务编号 + 阶段名」，例如「35 复核」「67 实施」「71 合并」：
 * - 去掉 identifier 的 `TASK-` 前缀，仅保留数字编号；
 * - 阶段名来自 execution purpose（work=实施、review=复核、merge=合并）。
 * 未提供 purpose 时（如历史执行记录）仅保留编号。
 */
export function formatTaskboardSessionTitle(
  task: Pick<TaskBoardTask, 'identifier'>,
  purpose?: TaskBoardExecutionPurpose,
): string {
  const number = task.identifier.trim().replace(/^TASK-/i, '').trim();
  const phase = purpose ? TASKBOARD_PURPOSE_LABELS[purpose] : '';
  return phase ? `${number} ${phase}` : number;
}

export const writeTaskboardSessionTitle: TaskboardSessionTitleWriter = async ({
  store,
  sessionId,
  transcriptPath,
}) => {
  const context = await store.getExecutionContextBySessionId(sessionId);
  if (!context) throw new Error(`任务看板会话上下文不存在：${sessionId}`);

  const title = formatTaskboardSessionTitle(context.task, context.execution?.purpose);
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
