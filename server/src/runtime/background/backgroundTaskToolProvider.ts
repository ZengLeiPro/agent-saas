import { z } from 'zod';

import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from '../../agent/toolRuntime.js';
import { loadToolDescription } from '../../agent/tools/descriptionLoader.js';
import { customerSafeRuntimeError } from '../runtimeFailure.js';
import type { RunRecord } from '../runStore.js';
import type { BackgroundTaskRuntime } from './backgroundTaskRuntime.js';

/**
 * 后台任务统一治理工具（2026-08-03 工具面收敛批次）。
 *
 * 由五个工具合并而来：BackgroundTaskList / BackgroundTaskStatus / BackgroundTaskCancel
 * + BashOutput / KillBash。合并依据：后台命令自 2026-07-19 起就注册在同一个
 * durable background task registry（Shell(mode=background) 启动即 reserveCommand），
 * 旧的两组工具是同一 registry 的两个入口，模型面维持两套「后台」心智徒增误选。
 *
 * hand 端协议零改动：output/cancel 内部仍按协议名 BashOutput/KillBash 透传
 * （见 DurableBackgroundTaskService.invokeCommandControl / cancel）。
 */
const backgroundTaskSchema = z.object({
  action: z.enum(['list', 'status', 'output', 'cancel']).describe(
    'list = 列出当前会话的后台任务；status = 查询单个任务状态、结果摘要与完整输出文件位置；output = 续读运行中后台命令的增量输出；cancel = 取消 pending/running 任务（命令任务会同时终止 ACS 内的进程）。',
  ),
  task_id: z.string().min(1).optional().describe(
    'Agent(mode=background) 或 Shell(mode=background) 返回的 taskId。status/output/cancel 必填。',
  ),
  limit: z.number().int().min(1).max(100).optional().describe('list 专用：返回条数上限，默认 20。'),
  stdout_offset: z.number().int().min(0).optional().describe('output 专用：stdout 续读偏移字节，默认 0。'),
  stderr_offset: z.number().int().min(0).optional().describe('output 专用：stderr 续读偏移字节，默认 0。'),
  limit_bytes: z.number().int().min(1).max(64 * 1024).optional().describe('output 专用：本次最多返回字节数，默认 20000。'),
  wait_ms: z.number().int().min(0).max(30_000).optional().describe('output 专用：无新输出时最长等待毫秒数，默认 0。'),
});

type BackgroundTaskInput = z.infer<typeof backgroundTaskSchema>;

export const backgroundTaskToolDescriptor: ToolDescriptor<BackgroundTaskInput> = {
  id: 'BackgroundTask',
  name: 'BackgroundTask',
  displayName: '后台任务',
  description: loadToolDescription('BackgroundTask'),
  schema: backgroundTaskSchema,
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'agent.background.manage',
  category: 'core',
  label: '后台任务',
};

export class BackgroundTaskToolProvider implements ToolProvider {
  constructor(private readonly runtime: BackgroundTaskRuntime) {}

  list(): ToolDescriptor[] {
    return [backgroundTaskToolDescriptor];
  }

  async invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== backgroundTaskToolDescriptor.id) return undefined;
    const input = backgroundTaskSchema.parse(call.input);

    if (input.action === 'list') {
      const tasks = await this.runtime.list(context, input.limit ?? 20);
      return { content: JSON.stringify({ tasks: tasks.map((task) => toTaskView(task, false)) }) };
    }

    const taskId = input.task_id;
    if (!taskId) throw new Error(`BackgroundTask(action="${input.action}") 需要 task_id。`);

    if (input.action === 'status') {
      const task = await this.runtime.get(context, taskId);
      if (!task) throw new Error('后台任务不存在，或不属于当前会话/用户。');
      return { content: JSON.stringify(toTaskView(task, true)) };
    }
    if (input.action === 'output') {
      const result = await this.runtime.readCommandOutput(context, {
        taskId,
        ...(input.stdout_offset !== undefined ? { stdoutOffset: input.stdout_offset } : {}),
        ...(input.stderr_offset !== undefined ? { stderrOffset: input.stderr_offset } : {}),
        ...(input.limit_bytes !== undefined ? { limitBytes: input.limit_bytes } : {}),
        ...(input.wait_ms !== undefined ? { waitMs: input.wait_ms } : {}),
      });
      return { content: result.content };
    }
    // action === 'cancel'
    const task = await this.runtime.cancel(context, taskId);
    return { content: JSON.stringify(toTaskView(task, true)) };
  }
}

function toTaskView(task: RunRecord, includeFullResult: boolean): Record<string, unknown> {
  const result = task.metadata.backgroundResult;
  const safeResult = result && typeof result === 'object'
    ? result as Record<string, unknown>
    : undefined;
  const failureKind = safeResult?.failureKind === 'policy_rejection' ? 'policy_rejection' : undefined;
  return {
    taskId: task.runId,
    shortTaskId: typeof task.metadata.shortTaskId === 'string' ? task.metadata.shortTaskId : undefined,
    taskType: task.metadata.backgroundTaskType === 'command' ? 'command' : 'agent',
    status: task.status,
    description: typeof task.metadata.description === 'string' ? task.metadata.description : undefined,
    model: task.model,
    requestedAt: task.requestedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt ?? task.failedAt ?? task.cancelledAt,
    statusReason: customerSafeRuntimeError(task.statusReason, failureKind),
    wakeState: task.metadata.wakeState,
    result: safeResult ? {
      status: safeResult.status,
      text: typeof safeResult.text === 'string'
        ? includeFullResult ? safeResult.text : safeResult.text.slice(0, 500)
        : undefined,
      errorMessage: customerSafeRuntimeError(
        typeof safeResult.errorMessage === 'string' ? safeResult.errorMessage : undefined,
        failureKind,
      ),
      failureKind: safeResult.failureKind,
      recoveryAction: safeResult.recoveryAction,
      spillPath: safeResult.spillPath,
      totalTokens: safeResult.totalTokens,
      toolUseCount: safeResult.toolUseCount,
      turnCount: safeResult.turnCount,
      durationMs: safeResult.durationMs,
    } : undefined,
  };
}
