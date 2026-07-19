import { z } from 'zod';

import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from '../../agent/toolRuntime.js';
import type { RunRecord } from '../runStore.js';
import type { BackgroundTaskRuntime } from './backgroundTaskRuntime.js';

const listSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
});
const taskSchema = z.object({
  task_id: z.string().min(1).describe('Agent(mode=background) 或 Shell(mode=background) 返回的 taskId。'),
});

export class BackgroundTaskToolProvider implements ToolProvider {
  private readonly descriptors: ToolDescriptor[] = [
    {
      id: 'BackgroundTaskList',
      name: 'BackgroundTaskList',
      displayName: '后台任务列表',
      description: '列出当前会话创建的后台 Agent/命令任务及其真实运行状态。通常无需轮询；仅在需要主动核对时调用。',
      schema: listSchema,
      risk: 'safe',
      approvalMode: 'never',
      auditCategory: 'agent.background.list',
      category: 'core',
      label: '后台任务列表',
    },
    {
      id: 'BackgroundTaskStatus',
      name: 'BackgroundTaskStatus',
      displayName: '后台任务状态',
      description: '查询当前会话内某个后台 Agent/命令任务的状态、结果摘要和完整输出文件位置。',
      schema: taskSchema,
      risk: 'safe',
      approvalMode: 'never',
      auditCategory: 'agent.background.status',
      category: 'core',
      label: '后台任务状态',
    },
    {
      id: 'BackgroundTaskCancel',
      name: 'BackgroundTaskCancel',
      displayName: '取消后台任务',
      description: '取消当前会话创建的 pending/running 后台 Agent/命令任务。命令任务会同时终止 ACS 内的进程；已进入终态的任务保持原状态。',
      schema: taskSchema,
      risk: 'safe',
      approvalMode: 'never',
      auditCategory: 'agent.background.cancel',
      category: 'core',
      label: '取消后台任务',
    },
  ];

  constructor(private readonly runtime: BackgroundTaskRuntime) {}

  list(): ToolDescriptor[] {
    return this.descriptors;
  }

  async invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId === 'BackgroundTaskList') {
      const input = listSchema.parse(call.input);
      const tasks = await this.runtime.list(context, input.limit);
      return { content: JSON.stringify({ tasks: tasks.map((task) => toTaskView(task, false)) }) };
    }
    if (call.toolId === 'BackgroundTaskStatus') {
      const input = taskSchema.parse(call.input);
      const task = await this.runtime.get(context, input.task_id);
      if (!task) throw new Error('后台任务不存在，或不属于当前会话/用户。');
      return { content: JSON.stringify(toTaskView(task, true)) };
    }
    if (call.toolId === 'BackgroundTaskCancel') {
      const input = taskSchema.parse(call.input);
      const task = await this.runtime.cancel(context, input.task_id);
      return { content: JSON.stringify(toTaskView(task, true)) };
    }
    return undefined;
  }
}

function toTaskView(task: RunRecord, includeFullResult: boolean): Record<string, unknown> {
  const result = task.metadata.backgroundResult;
  const safeResult = result && typeof result === 'object'
    ? result as Record<string, unknown>
    : undefined;
  return {
    taskId: task.runId,
    taskType: task.metadata.backgroundTaskType === 'command' ? 'command' : 'agent',
    status: task.status,
    description: typeof task.metadata.description === 'string' ? task.metadata.description : undefined,
    model: task.model,
    requestedAt: task.requestedAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt ?? task.failedAt ?? task.cancelledAt,
    statusReason: task.statusReason,
    wakeState: task.metadata.wakeState,
    result: safeResult ? {
      status: safeResult.status,
      text: typeof safeResult.text === 'string'
        ? includeFullResult ? safeResult.text : safeResult.text.slice(0, 500)
        : undefined,
      errorMessage: safeResult.errorMessage,
      spillPath: safeResult.spillPath,
      totalTokens: safeResult.totalTokens,
      toolUseCount: safeResult.toolUseCount,
      turnCount: safeResult.turnCount,
      durationMs: safeResult.durationMs,
    } : undefined,
  };
}
