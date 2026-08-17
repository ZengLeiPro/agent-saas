import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolResult,
  ToolRuntime,
} from '../agent/toolRuntime.js';
import type { OrgAgentRuntimePolicy } from '../data/orgAgents/runtimePolicy.js';
import type { InstructionSection } from './types.js';

const DISPATCHER_ALLOWED_TOOLS = new Set([
  'Agent',
  'BackgroundTask',
  'AskUserQuestion',
  'TodoWrite',
  'SessionContext',
]);

export function resolveAgentModePolicy(
  mode: OrgAgentRuntimePolicy['executionMode'] | undefined,
): 'any' | 'background_only' {
  return mode === 'dispatcher' ? 'background_only' : 'any';
}

export function appendDispatcherInstructionSection(
  sections: InstructionSection[],
  mode: OrgAgentRuntimePolicy['executionMode'] | undefined,
): void {
  const section = dispatcherInstructionSection(mode);
  if (section) sections.push(section);
}

function dispatcherInstructionSection(
  mode: OrgAgentRuntimePolicy['executionMode'] | undefined,
): InstructionSection | null {
  if (mode !== 'dispatcher') return null;
  return {
    key: 'dispatcher_mode',
    name: '前台调度器模式',
    content: [
      '<dispatcher-mode>',
      '你是始终可响应的前台调度器，只负责接单、澄清、派发、状态查询、取消确认和结果播报。',
      '寒暄、身份说明、需求澄清和已有任务状态可直接回复；其他任何实质咨询或执行请求都必须创建 background Worker。',
      '不得亲自查资料、分析问题、读写文件、执行命令或调用业务工具；不要以“任务简单”为理由例外处理。',
      '派发成功后立即回复短任务 ID、queued/running 状态，并明确“已交给执行 Agent，我继续在线”。',
      '用户引用任务 ID 时优先查询或取消现有任务，不要误建无关 Worker。',
      'Worker 完成通知由平台可靠投递；不要声称自己已完成 Worker 尚未完成的工作。',
      '</dispatcher-mode>',
    ].join('\n'),
  };
}

/**
 * Non-removable runtime boundary for an organization Agent acting as a front
 * desk dispatcher. Governance profiles may narrow this set, never expand it.
 */
export function applyOrgAgentExecutionMode(
  runtime: ToolRuntime,
  mode: OrgAgentRuntimePolicy['executionMode'] | undefined,
  delegationDisabled = false,
): ToolRuntime {
  return mode === 'dispatcher' ? new DispatcherToolRuntime(runtime, delegationDisabled) : runtime;
}

class DispatcherToolRuntime implements ToolRuntime {
  constructor(private readonly inner: ToolRuntime, private readonly delegationDisabled: boolean) {}

  list(context?: ToolCallContext): ToolDescriptor[] {
    return this.inner.list(context).filter(descriptor => isDispatcherTool(descriptor, this.delegationDisabled));
  }

  async invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult> {
    const descriptor = this.inner.list(context).find(
      candidate => candidate.id === call.toolId || candidate.name === call.toolId,
    );
    if (!descriptor || !isDispatcherTool(descriptor, this.delegationDisabled)) {
      throw new Error(`前台调度器不允许调用执行工具 ${call.toolId}`);
    }
    if (matchesTool(descriptor, 'Agent')) {
      const mode = (call.input as { mode?: unknown } | undefined)?.mode;
      if (mode !== undefined && mode !== 'background') {
        throw new Error('前台调度器只允许创建 background Worker');
      }
    }
    return this.inner.invoke(call, context);
  }
}

function isDispatcherTool(descriptor: ToolDescriptor, delegationDisabled: boolean): boolean {
  if (delegationDisabled && (matchesTool(descriptor, 'Agent') || matchesTool(descriptor, 'BackgroundTask'))) return false;
  return [...DISPATCHER_ALLOWED_TOOLS].some(name => matchesTool(descriptor, name));
}

function matchesTool(descriptor: ToolDescriptor, name: string): boolean {
  return descriptor.id === name || descriptor.name === name;
}
