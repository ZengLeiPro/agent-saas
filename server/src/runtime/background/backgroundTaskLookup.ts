import type { ToolCallContext } from '../../agent/toolRuntime.js';
import type { RunRecord, RunStore } from '../runStore.js';

export async function findBackgroundTasksByIdentifier(
  runStore: RunStore,
  context: ToolCallContext,
  identifier: string,
): Promise<RunRecord[]> {
  const parentSessionId = context.sessionId ?? context.workspace.sessionId;
  if (!parentSessionId) throw new Error('缺少当前 sessionId。');
  const identity = context.channelContext.sessionOwner ?? context.channelContext.user;
  const options = {
    userId: identity?.id ?? context.workspace.userId,
    tenantId: identity?.tenantId ?? context.workspace.tenantId,
  };
  if (runStore.findBackgroundTasksByIdentifier) {
    return runStore.findBackgroundTasksByIdentifier(parentSessionId, identifier, options);
  }
  const recent = await runStore.listBackgroundTasks!(parentSessionId, { ...options, limit: 100 });
  return recent.filter(task => (
    task.runId === identifier || task.metadata.shortTaskId === identifier.toUpperCase()
  ));
}
