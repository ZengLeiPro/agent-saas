import type { TaskboardExecutionDispatch, TaskboardExecutionStore } from './types.js';

export interface TaskboardSessionGroupingOptions {
  store: Pick<TaskboardExecutionStore, 'getExecutionModelContext'>;
  groupTaskboardSession?: (input: {
    boardId: string;
    boardName: string;
    sessionId: string;
    owner: string;
  }) => Promise<{ id: string }>;
  onSessionGrouped?: (event: {
    boardId: string;
    boardName: string;
    sessionId: string;
    groupId: string;
    userId: string;
  }) => void | Promise<void>;
  logger?: { warn(message: string): void };
}

export async function groupTaskboardSessionBeforeDispatch(
  options: TaskboardSessionGroupingOptions,
  dispatch: TaskboardExecutionDispatch,
  session: { sessionId: string; username: string },
): Promise<void> {
  if (!options.groupTaskboardSession) return;
  const board = await options.store.getExecutionModelContext({
    tenantId: dispatch.tenantId,
    ownerUserId: dispatch.ownerUserId,
    username: session.username,
  }, dispatch.taskId);
  if (!board.boardId || !board.boardName) {
    throw new Error(`任务看板分组上下文不完整：${dispatch.taskId}`);
  }
  const group = await options.groupTaskboardSession({
    boardId: board.boardId,
    boardName: board.boardName,
    sessionId: session.sessionId,
    owner: dispatch.ownerUserId,
  });
  try {
    await options.onSessionGrouped?.({
      boardId: board.boardId,
      boardName: board.boardName,
      sessionId: session.sessionId,
      groupId: group.id,
      userId: dispatch.ownerUserId,
    });
  } catch (error) {
    options.logger?.warn(
      `Taskboard session group notification failed: session=${session.sessionId} error=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
