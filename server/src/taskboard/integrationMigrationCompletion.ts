import type { TaskboardExecutionContext, TaskboardExecutionStore } from './types.js';

const MIGRATION_ERROR = 'Integration task requires Agent-first workflow migration';

export async function absorbLegacyIntegrationRuntimeCompletion(
  store: TaskboardExecutionStore,
  context: TaskboardExecutionContext,
  runId: string,
  reconcileLeaseId?: string,
): Promise<boolean> {
  if (context.task.kind !== 'integration' || context.task.workflowVersion === 3) return false;
  const completion = {
    status: 'failed' as const,
    error: MIGRATION_ERROR,
    commentBody: MIGRATION_ERROR,
  };
  if (reconcileLeaseId) {
    await store.completeExecutionFromReconcile(runId, completion, reconcileLeaseId);
  } else {
    await store.completeExecution(runId, completion);
  }
  return true;
}
