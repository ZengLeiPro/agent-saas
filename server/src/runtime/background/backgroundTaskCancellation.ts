import type { ToolCallContext } from '../../agent/toolRuntime.js';
import { createLogger } from '../../utils/logger.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import { runtimeRunController } from '../runController.js';
import type { RunRecord } from '../runStore.js';
import { resolveSessionCatalog } from '../rawRuntimeRunDispatch.js';
import { invokeBackgroundCommandControl } from './backgroundTaskCommandControl.js';
import { parseBackgroundTaskMetadata } from './backgroundTaskMetadata.js';
import { failureResult, isTerminal } from './backgroundTaskServiceSupport.js';
import { markBackgroundTaskTerminal } from './backgroundTaskTerminal.js';
import { authorizeOrgAgentWorkOrderMutation } from './backgroundWorkOrderControl.js';
import type { OrgAgentBackgroundWorkCoordinator } from './orgAgentBackgroundWork.js';

const logger = createLogger('BackgroundTaskService');

export async function cancelBackgroundTask(
  config: RawRuntimeRunDispatchConfig,
  orgWork: OrgAgentBackgroundWorkCoordinator,
  context: ToolCallContext,
  task: RunRecord,
): Promise<RunRecord> {
  if (isTerminal(task.status)) return task;
  const metadata = parseBackgroundTaskMetadata(task);
  if (metadata?.workOrderId && metadata.orgAgentChannel) {
    const work = await authorizeOrgAgentWorkOrderMutation(config, context, metadata.workOrderId);
    const cancelled = await orgWork.cancel(work.tenantId, work.workOrderId, work.version);
    return cancelled ?? task;
  }
  const message = '后台任务由父会话请求取消';
  const updated = await markBackgroundTaskTerminal(
    config.runStore!,
    task.runId,
    'cancelled',
    message,
    {
      backgroundResult: failureResult('cancelled', message),
      wakeState: 'pending',
      backgroundFinishedAt: new Date().toISOString(),
    },
  );
  if (!updated) {
    const current = await config.runStore!.get(task.runId);
    if (current && isTerminal(current.status)) return current;
    throw new Error('后台任务取消失败。');
  }
  if (metadata?.taskType === 'command') {
    await invokeBackgroundCommandControl(config, task, metadata, 'KillBash', {
      task_id: task.runId,
    }).catch(() => undefined);
  }
  runtimeRunController.abort(task.runId);
  await resolveSessionCatalog(config)
    .markStatus(task.sessionId, 'error')
    .catch(() => undefined);
  await orgWork
    .syncTerminal(updated, 'cancelled', failureResult('cancelled', message), message)
    .catch((error) =>
      logger.error(`组织群任务取消状态同步失败 task=${task.runId}: ${String(error)}`),
    );
  return updated;
}
