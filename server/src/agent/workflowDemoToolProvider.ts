import { z } from 'zod';

import type { DemoManifestRecord } from '../../../shared/src/index.js';
import {
  executeWorkflowDemoAgentStep,
  getWorkflowDemoProgress,
  type ExecuteWorkflowDemoStepResult,
  type WorkflowDemoAgentInvocationProvenance,
} from '../data/workflowDemos/engine.js';
import type { WorkflowDemoStore } from '../data/workflowDemos/store.js';
import { canonicalToolInputDigest } from '../runtime/canonicalToolInput.js';
import type { ToolInvocationStore } from '../runtime/toolInvocationStore.js';
import { loadToolDescription } from './tools/descriptionLoader.js';
import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from './toolRuntime.js';

export interface WorkflowDemoStepInput {
  workflowRunId: string;
  eventId: string;
  expectedVersion?: number;
}

export interface WorkflowDemoToolProviderOptions {
  workflowDemoStore: WorkflowDemoStore;
  toolInvocationStore: ToolInvocationStore;
  resolveManifest: (demoId: string) => DemoManifestRecord | Promise<DemoManifestRecord>;
  /** 仅由 Raw Runtime 在校验消息 metadata 后注入；普通会话不会构造本 Provider。 */
  dispatch: {
    runId: string;
    eventId: string;
  } | (() => { runId: string; eventId: string } | null);
}

const workflowDemoStepSchema = z.object({
  workflowRunId: z.string().uuid().describe('平台创建的 Workflow Demo run ID。'),
  eventId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/)
    .describe('平台告知的当前下一步事件 ID。'),
  expectedVersion: z.number().int().min(1).optional()
    .describe('写动作执行前刚刚读取到的业务对象版本；纯读取步骤可省略。'),
}).strict();

export const workflowDemoStepToolDescriptor: ToolDescriptor<WorkflowDemoStepInput> = {
  id: 'WorkflowDemoStep',
  name: 'WorkflowDemoStep',
  displayName: 'Advance Workflow Demo',
  description: loadToolDescription('WorkflowDemoStep'),
  schema: workflowDemoStepSchema,
  risk: 'safe',
  approvalMode: 'never',
  auditCategory: 'workflow.demo.step',
  category: 'core',
  label: '推进工作流演示',
};

export class WorkflowDemoToolProvider implements ToolProvider {
  constructor(private readonly options: WorkflowDemoToolProviderOptions) {
    if (!options.workflowDemoStore || !options.toolInvocationStore || !options.resolveManifest) {
      throw new Error('WorkflowDemoToolProvider 缺少必要的持久化依赖');
    }
  }

  list(context?: ToolCallContext): ToolDescriptor[] {
    const identity = resolveIdentity(context);
    return identity && this.resolveDispatch() ? [workflowDemoStepToolDescriptor] : [];
  }

  async invoke(call: AuthorizedToolCall, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== workflowDemoStepToolDescriptor.id) return undefined;
    const input: WorkflowDemoStepInput = workflowDemoStepSchema.parse(call.input);
    const dispatch = this.resolveDispatch();
    if (!dispatch || input.workflowRunId !== dispatch.runId) {
      throw providerError(
        'Workflow Demo 工具调用与本次受信任调度不一致',
        'WORKFLOW_DEMO_DISPATCH_CAPABILITY_MISMATCH',
      );
    }
    const provenance = await this.verifyInvocation(context, input);
    const run = await this.options.workflowDemoStore.getByRunId(input.workflowRunId);
    if (!run) throw providerError('Workflow Demo run 不存在', 'WORKFLOW_DEMO_RUN_NOT_FOUND');
    if (run.tenantId !== provenance.tenantId || run.actorUserId !== provenance.actorUserId) {
      throw providerError('当前 Agent 身份无权推进该 Workflow Demo run', 'WORKFLOW_DEMO_AGENT_IDENTITY_MISMATCH');
    }

    const manifest = await this.options.resolveManifest(run.demoId);
    if (manifest.id !== run.demoId) {
      throw providerError('服务端冻结的 Demo 定义与运行不一致', 'WORKFLOW_DEMO_MANIFEST_MISMATCH');
    }
    const result = await executeWorkflowDemoAgentStep(this.options.workflowDemoStore, provenance, {
      manifest,
      ...input,
    });
    const progress = await getWorkflowDemoProgress(this.options.workflowDemoStore, manifest, result.run);
    return { content: JSON.stringify(projectToolResult(result, progress), null, 2) };
  }

  private resolveDispatch(): { runId: string; eventId: string } | null {
    return typeof this.options.dispatch === 'function'
      ? this.options.dispatch()
      : this.options.dispatch;
  }

  private async verifyInvocation(
    context: ToolCallContext,
    input: WorkflowDemoStepInput,
  ): Promise<WorkflowDemoAgentInvocationProvenance> {
    const identity = resolveIdentity(context);
    if (!identity) {
      throw providerError('当前 Agent 调用缺少用户与组织身份', 'WORKFLOW_DEMO_AGENT_IDENTITY_REQUIRED');
    }
    const { sessionId, runId, toolCallId, invocationId } = context;
    if (!sessionId || !runId || !toolCallId || !invocationId) {
      throw providerError('当前调用缺少可信的 Agent Runtime 来源', 'WORKFLOW_DEMO_AGENT_PROVENANCE_REQUIRED');
    }
    if (invocationId !== `${runId}:${toolCallId}`) {
      throw providerError('Agent Runtime 调用标识不一致', 'WORKFLOW_DEMO_AGENT_PROVENANCE_MISMATCH');
    }

    const invocation = await this.options.toolInvocationStore.get(invocationId);
    if (!invocation || invocation.status !== 'running') {
      throw providerError('找不到正在执行的可信工具调用', 'WORKFLOW_DEMO_AGENT_INVOCATION_NOT_RUNNING');
    }
    const toolInputDigest = canonicalToolInputDigest(input);
    const invocationMatches = invocation.invocationId === invocationId
      && invocation.runId === runId
      && invocation.sessionId === sessionId
      && invocation.toolCallId === toolCallId
      && invocation.toolName === workflowDemoStepToolDescriptor.name
      && invocation.tenantId === identity.tenantId
      && invocation.metadata.toolId === workflowDemoStepToolDescriptor.id
      && invocation.metadata.toolInputDigest === toolInputDigest;
    if (!invocationMatches) {
      throw providerError('工具调用审计记录与当前 Agent 调用不一致', 'WORKFLOW_DEMO_AGENT_PROVENANCE_MISMATCH');
    }

    return {
      runtimeSessionId: sessionId,
      runtimeRunId: runId,
      toolInvocationId: invocationId,
      toolCallId,
      toolId: 'WorkflowDemoStep',
      toolName: 'WorkflowDemoStep',
      toolInputDigest,
      tenantId: identity.tenantId,
      actorUserId: identity.id,
    };
  }
}

function resolveIdentity(context?: ToolCallContext): { id: string; tenantId: string } | null {
  const identity = context?.channelContext.user ?? context?.channelContext.sessionOwner;
  if (!identity?.id || !identity.tenantId) return null;
  return { id: identity.id, tenantId: identity.tenantId };
}

function projectToolResult(
  result: ExecuteWorkflowDemoStepResult,
  progress: Awaited<ReturnType<typeof getWorkflowDemoProgress>>,
) {
  return {
    workflowRunId: result.run.runId,
    eventId: result.event.eventId,
    phase: result.event.phase,
    state: result.event.state,
    runStatus: result.run.status,
    completed: result.completed,
    nextEventId: progress.nextEventId,
    nextPhase: progress.nextPhase,
    awaitingExternal: progress.awaitingExternal,
    ...(result.replayId ? { replayId: result.replayId } : {}),
    objects: result.objects.map(({ id, label, state, version }) => ({ id, label, state, version })),
  };
}

function providerError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
