import type { RunRecord } from '../runStore.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import { invokeBackgroundCommandControl } from './backgroundTaskCommandControl.js';
import type { BackgroundCommandOutputRequest } from './backgroundTaskRuntime.js';
import { parseBackgroundTaskMetadata } from './backgroundTaskMetadata.js';
import { isTerminal } from './backgroundTaskServiceSupport.js';

export async function readBackgroundCommandOutput(
  config: RawRuntimeRunDispatchConfig,
  task: RunRecord,
  request: BackgroundCommandOutputRequest,
): Promise<{ content: string }> {
  const metadata = parseBackgroundTaskMetadata(task);
  if (metadata?.taskType !== 'command')
    throw new Error(
      '该任务不是后台命令任务；后台 Agent 任务请用 BackgroundTask(action="status") 查看结果。',
    );
  if (isTerminal(task.status))
    throw new Error(
      `后台命令已进入终态（${task.status}）；用 BackgroundTask(action="status") 查看结果摘要与完整输出文件位置。`,
    );
  return await invokeBackgroundCommandControl(config, task, metadata, 'BashOutput', {
    task_id: request.taskId,
    stdout_offset: request.stdoutOffset ?? 0,
    stderr_offset: request.stderrOffset ?? 0,
    limit_bytes: request.limitBytes ?? 20_000,
    wait_ms: request.waitMs ?? 0,
  });
}
