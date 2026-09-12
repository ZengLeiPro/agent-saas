/**
 * Agent 工具 provider（D9，2026-07-06）：模型可见的 `Agent` 工具入口。
 *
 * 职责边界：
 *   - descriptor：参数极简（行业收敛共识——prompt + 可选类型/模型，复杂度藏进配置），
 *     description 从 descriptions/Agent.md 加载并把限额常量动态渲染进去
 *     （Hermes 教训：固定文案会让模型按默认值自我设限）。
 *   - invoke：委托 subagentRunner 跑子 loop；本层只负责三件事——
 *     ① durable subagent_started/finished 事件写入**父 session** event store
 *       （UI SubagentBlock / Run Trace 的数据源，经 PG NOTIFY 通路到前端）；
 *     ② 结果截断保险丝 + 全文 spill（D5，防 fan-out 回传炸父上下文）；
 *     ③ 终态类型化文案（错误绝不伪装成结论）。
 *   - risk:'safe' / approvalMode:'never'：Agent 工具本身无副作用（副作用在子 agent
 *     的具体工具上，各自受子 loop 的 policy/剥夺清单约束）；safe 同时是 drainToolCalls
 *     并行窗的前提（approval suspension 通过抛异常中止 generator，只有免审批工具
 *     才能安全并行）。
 */

import { createHash, randomUUID } from 'crypto';
import { join } from 'path';

import { z } from 'zod';

import { loadToolDescription } from '../../agent/tools/descriptionLoader.js';
import type {
  AuthorizedToolCall,
  ToolCallContext,
  ToolDescriptor,
  ToolProvider,
  ToolResult,
} from '../../agent/toolRuntime.js';
import type { ExecutionTransportRegistry } from '../executionTransport.js';
import {
  createEventStoreForSession,
  resolveSessionCatalog,
  type RawRuntimeRunDispatchConfig,
} from '../rawRuntimeRunDispatch.js';
import type { TenantRemoteHandAuthTokenResolver } from '../tenantRemoteHandResolver.js';
import type { EventStore } from '../types.js';
import { createLogger } from '../../utils/logger.js';
import { writeTrustedFile } from '../../security/trustedFile.js';
import { getSubagentType, SUBAGENT_TYPES } from './agentTypes.js';
import {
  SUBAGENT_HARD_TIMEOUT_MS,
  SUBAGENT_MAX_TURNS,
  SUBAGENT_PER_RUN_MAX_CONCURRENCY,
  SUBAGENT_RESULT_MAX_CHARS,
  type SubagentLimiter,
} from './subagentLimits.js';
import { runSubagent, type SubagentOutcome } from './subagentRunner.js';
import { customerSafeRuntimeError } from '../runtimeFailure.js';
import { formatSubagentFailureHeader } from './subagentFailureFormatting.js';
import { deriveSubagentAgentId } from './subagentExecutionOptions.js';
import {
  resolvePersistedSubagentIdentity,
  type PersistedSubagentIdentity,
} from './subagentContinuation.js';
import {
  formatSubagentModelCatalog,
  projectSubagentModelCatalog,
} from './subagentModelCatalog.js';
import type { SubagentModelPolicy } from './subagentExecutionOptions.js';

const logger = createLogger('AgentToolProvider');
const SUBAGENT_RESULT_PREVIEW_CHARS = 2_000;

const agentToolBaseShape = {
  description: z.string().min(1).max(120).optional()
    .describe('简短任务摘要。首次创建必填；resume 时省略则继承原任务摘要。'),
  prompt: z.string().min(1)
    .describe('首次创建时是完整任务；resume 时是追加给同一子 Agent 的新指令。'),
  agent_type: z.enum(['general', 'explore']).optional()
    .describe('general = 全量工具执行者；explore = 调研、分析与报告交付。resume 时省略则继承。'),
  include_company_info: z.boolean().optional()
    .describe('仅 general 有效。resume 不得从 false 扩权为 true。'),
  model: z.string().min(1).optional()
    .describe('可选模型 ref。锁定策略冲突会明确报错，不会静默覆盖。'),
  effort: z.string().min(1).optional()
    .describe('可选 reasoning effort；只接受当前模型与 transport 已验证的值。'),
  resume: z.string().min(1).optional()
    .describe('稳定 agent_id。提供后向同一逻辑子 Agent 追加消息或创建续接 run。'),
};

const agentToolSchema = z.object({
  ...agentToolBaseShape,
  mode: z.enum(['foreground', 'background']).optional()
    .describe('foreground = 等待子 Agent 完成并返回结果；background = 持久化后台执行，立即返回 taskId，完成后自动唤醒当前会话。'),
});

const dispatcherAgentToolSchema = z.object({
  ...agentToolBaseShape,
  mode: z.literal('background').optional()
    .describe('前台调度器只能创建持久化后台 Worker。'),
});

export type AgentToolInput = z.infer<typeof agentToolSchema>;

export interface AgentToolProviderOptions {
  config: RawRuntimeRunDispatchConfig;
  executionTransportRegistry: ExecutionTransportRegistry;
  tenantHandResolver: TenantRemoteHandAuthTokenResolver;
  /** 父 run provider 集快照（不含本 provider，collectRuntimeTooling 在 push 之前截取）。 */
  parentProviders: ToolProvider[];
  /** 测试注入口。 */
  limiter?: SubagentLimiter;
  hardTimeoutMs?: number;
  resultMaxChars?: number;
  runSubagentImpl?: typeof runSubagent;
  /** Dispatcher front desk may only create durable background Workers. */
  modePolicy?: 'any' | 'background_only';
  inheritedModelRef?: string;
  workerModel?: SubagentModelPolicy;
  profileModels?: Partial<Record<'general' | 'explore', SubagentModelPolicy>>;
}

interface ParentEventStoreBinding {
  eventStore: EventStore;
  tenantId: string;
}

export class AgentToolProvider implements ToolProvider {
  private readonly descriptor: ToolDescriptor<AgentToolInput>;
  private readonly resultMaxChars: number;
  private readonly runSubagentImpl: typeof runSubagent;

  constructor(private readonly options: AgentToolProviderOptions) {
    this.resultMaxChars = options.resultMaxChars ?? SUBAGENT_RESULT_MAX_CHARS;
    this.runSubagentImpl = options.runSubagentImpl ?? runSubagent;
    this.descriptor = {
      id: 'Agent',
      name: 'Agent',
      displayName: 'Agent',
      description: options.modePolicy === 'background_only'
        ? `${renderAgentToolDescription()}\n\n当前会话是前台调度器：只能创建 background Worker；可在组织策略允许时显式选择 model/effort。`
        : renderAgentToolDescription(),
      schema: options.modePolicy === 'background_only' ? dispatcherAgentToolSchema : agentToolSchema,
      risk: 'safe',
      approvalMode: 'never',
      concurrency: 'parallel',
      auditCategory: 'agent.subagent',
      category: 'core',
      label: '子 Agent 调度',
    };
  }

  list(context?: ToolCallContext): ToolDescriptor[] {
    if (!context || !this.options.config.getSubagentModelCatalog) return [this.descriptor];
    const tenantId = context.channelContext.sessionOwner?.tenantId
      ?? context.channelContext.user?.tenantId
      ?? context.workspace.tenantId;
    const catalog = this.options.config.getSubagentModelCatalog(tenantId);
    if (!catalog) return [this.descriptor];
    const renderForType = (agentType: 'general' | 'explore') => formatSubagentModelCatalog(
      projectSubagentModelCatalog({
        catalog,
        tenantId,
        inheritedModelRef: this.options.inheritedModelRef,
        profileModel: this.options.profileModels?.[agentType],
        workerModel: this.options.workerModel,
      }),
    );
    const general = renderForType('general');
    const explore = renderForType('explore');
    const catalogText = general === explore
      ? general
      : `general：\n${general}\n\nexplore：\n${explore}`;
    return [{ ...this.descriptor, description: `${this.descriptor.description}\n\n${catalogText}` }];
  }

  async invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== this.descriptor.id) return undefined;
    const input = this.descriptor.schema.parse(call.input) as AgentToolInput;
    const toolCallId = context.toolCallId ?? `agent-${randomUUID()}`;
    const resumeIdentity = input.resume
      ? await this.resolveResumeIdentity(input.resume, context)
      : undefined;
    if (resumeIdentity) this.assertResumeFields(input, resumeIdentity);
    const mode = resumeIdentity?.mode
      ?? input.mode
      ?? (this.options.modePolicy === 'background_only' ? 'background' : 'foreground');
    if (this.options.modePolicy === 'background_only' && mode !== 'background') {
      throw new Error('前台调度器只允许创建 background Worker。');
    }
    const agentTypeId = resumeIdentity?.agentType ?? input.agent_type ?? 'general';
    const agentType = getSubagentType(agentTypeId);
    if (!agentType) {
      throw new Error(`未知的 agent_type: ${agentTypeId}（可用：${Object.keys(SUBAGENT_TYPES).join(' / ')}）`);
    }
    const description = input.description ?? resumeIdentity?.description;
    if (!description) throw new Error('首次创建子 Agent 时 description 必填。');
    const includeCompanyInfo = input.include_company_info
      ?? resumeIdentity?.includeCompanyInfo
      ?? false;
    const requestedModel = input.model ?? resumeIdentity?.modelRef;
    const requestedEffort = input.effort ?? (input.model ? undefined : resumeIdentity?.effort);
    const agentId = resumeIdentity?.agentId ?? deriveSubagentAgentId({
      parentSessionId: context.sessionId ?? context.workspace.sessionId ?? 'missing-session',
      parentRunId: context.runId ?? 'missing-run',
      toolCallId,
    });

    if (resumeIdentity?.activePhysicalRun) {
      const steered = await this.trySteerActiveResume(
        resumeIdentity,
        input.prompt,
        context,
        toolCallId,
      );
      if (steered) return steered;
    } else if (resumeIdentity?.activeBackgroundTask) {
      const queued = await this.tryQueueBackgroundResume(
        resumeIdentity,
        input.prompt,
        context,
        toolCallId,
      );
      if (queued) return queued;
    }

    if (mode === 'background') {
      if (!this.options.config.backgroundTasks) {
        throw new Error('当前运行后端未启用 durable background Agent。');
      }
      const started = await this.options.config.backgroundTasks.enqueue(
        { ...context, toolCallId },
        {
          description,
          prompt: input.prompt,
          agentType: agentType.id,
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(requestedEffort ? { effort: requestedEffort } : {}),
          agentId,
          ...(resumeIdentity ? {
            continuation: {
              previousRunId: resumeIdentity.previousRunId,
              ...(resumeIdentity.childSessionId ? { previousSessionId: resumeIdentity.childSessionId } : {}),
              sequence: resumeIdentity.sequence,
            },
          } : {}),
          includeCompanyInfo,
        },
      );
      return {
        content: JSON.stringify({
          agent_id: started.agentId ?? agentId,
          taskId: started.taskId,
          shortTaskId: started.shortTaskId,
          status: started.status,
          description: started.description,
          model: started.model,
          ...(started.modelRef ? { model_ref: started.modelRef } : {}),
          ...(started.effort ? { effort: started.effort } : {}),
          delivery: started.delivery ?? 'accepted',
          resumable: true,
          message: `已交给执行 Agent，前台继续在线。请向用户回执任务 ${started.shortTaskId} 已排队，并说明可以继续发新任务。`,
        }),
      };
    }

    // 父 session event store：durable subagent_started/finished 的落点。
    // 解析失败（file backend 测试 fixture 等）不阻断执行，只丢观测事件。
    const parentEventStore = await this.resolveParentEventStore(context);

    let preparedContinuation: { childSessionId: string; childRunId: string } | undefined;
    if (resumeIdentity) {
      if (!resumeIdentity.childSessionId) throw new Error(`子 Agent ${agentId} 缺少可恢复的 child session。`);
      const reserve = this.options.config.runStore?.reserveSubagentContinuation;
      if (!reserve) throw new Error('当前运行后端未启用 idle continuation 原子占位，不能安全续接。');
      const parentSessionId = context.sessionId ?? context.workspace.sessionId;
      const parentRunId = context.runId;
      const previous = resumeIdentity.latestPhysicalRun ?? resumeIdentity.latestRun;
      if (!parentSessionId || !parentRunId || !previous.tenantId) {
        throw new Error('Agent(idle resume) 缺少父会话或目标租户上下文。');
      }
      const digest = createHash('sha256')
        .update(`subagent-continuation:${agentId}:${parentRunId}:${toolCallId}`)
        .digest('hex');
      const childRunId = `subcont-${digest.slice(0, 32)}`;
      const reservation = await reserve.call(this.options.config.runStore, {
        runId: childRunId,
        sessionId: resumeIdentity.childSessionId,
        userId: previous.userId,
        submitterUserId: context.channelContext.sessionOwner?.id ?? context.channelContext.user?.id,
        tenantId: previous.tenantId,
        model: previous.model,
        channel: previous.channel ?? context.channelContext.channel,
        idempotencyKey: childRunId,
        executionTarget: previous.executionTarget,
        workspaceId: previous.workspaceId,
        sandboxScopeId: previous.sandboxScopeId,
        agentId,
        parentSessionId,
        metadata: {
          subagent: true,
          subagentContinuationClaim: true,
          subagentAgentId: agentId,
          parentSessionId,
          parentRunId,
          parentToolCallId: toolCallId,
          agentType: agentType.id,
          subagentMode: 'foreground',
          description,
          includeCompanyInfo,
          modelRef: requestedModel ?? resumeIdentity.modelRef,
          ...(requestedEffort ? { effort: requestedEffort } : {}),
          subagentContinuation: {
            previousRunId: resumeIdentity.previousRunId,
            previousSessionId: resumeIdentity.childSessionId,
            sequence: resumeIdentity.sequence,
          },
        },
      });
      if (reservation.state === 'active') {
        const steered = await this.trySteerActiveResume(
          { ...resumeIdentity, activePhysicalRun: reservation.record },
          input.prompt,
          context,
          toolCallId,
        );
        if (steered) return steered;
        throw new Error(`子 Agent ${agentId} 当前处于 ${reservation.record.status}，不能安全创建并行续接 run。`);
      }
      preparedContinuation = { childSessionId: resumeIdentity.childSessionId, childRunId };
    }

    let startedInfo: { childSessionId: string; childRunId: string; model: string; effort?: string; agentId?: string } | null = null;
    const appendStarted = async (info: { childSessionId: string; childRunId: string; model: string; effort?: string; agentId?: string }): Promise<void> => {
      startedInfo = info;
      await this.appendParentEvent(parentEventStore, {
        type: 'subagent_started',
        runId: context.runId!,
        sessionId: context.sessionId!,
        toolCallId,
        agentType: agentType.id,
        description,
        childSessionId: info.childSessionId,
        childRunId: info.childRunId,
        model: info.model,
        ...(info.agentId ? { agentId: info.agentId } : {}),
        ...(info.effort ? { effort: info.effort } : {}),
      });
    };

    let outcome: SubagentOutcome;
    try {
      outcome = await this.runSubagentImpl({
        config: this.options.config,
        executionTransportRegistry: this.options.executionTransportRegistry,
        tenantHandResolver: this.options.tenantHandResolver,
        parentProviders: this.options.parentProviders,
        parentContext: { ...context, toolCallId },
        agentType,
        request: {
          description,
          prompt: input.prompt,
          ...(requestedModel ? { model: requestedModel } : {}),
          ...(requestedEffort ? { effort: requestedEffort } : {}),
          mode: 'foreground',
          agentId,
          ...(resumeIdentity ? {
            continuation: {
              previousRunId: resumeIdentity.previousRunId,
              ...(resumeIdentity.childSessionId ? { previousSessionId: resumeIdentity.childSessionId } : {}),
              sequence: resumeIdentity.sequence,
            },
          } : {}),
          includeCompanyInfo,
        },
        ...(resumeIdentity?.childSessionId ? {
          continuationChildSessionId: resumeIdentity.childSessionId,
          profileSourceSession: await resolveSessionCatalog(this.options.config).get(resumeIdentity.childSessionId)
            ?? undefined,
        } : {}),
        ...(preparedContinuation ? { preparedChildIdentity: preparedContinuation } : {}),
        ...(this.options.limiter ? { limiter: this.options.limiter } : {}),
        ...(this.options.hardTimeoutMs !== undefined ? { hardTimeoutMs: this.options.hardTimeoutMs } : {}),
        onChildRunCreated: appendStarted,
      });
    } catch (err) {
      if (preparedContinuation && !startedInfo) {
        await this.options.config.runStore?.markStatus(
          preparedContinuation.childRunId,
          'failed',
          err instanceof Error ? err.message : String(err),
          { subagentContinuationClaim: false },
        ).catch(() => undefined);
      }
      // started 已发但 runner 异常出逃（装配层错误）：补一条 finished(failed)，
      // 不让前端 SubagentBlock 永远停在 running。前置校验失败（未发 started）直接透传，
      // 由 invokeAuthorizedTool 转成标准化工具错误文本。
      const info = startedInfo as { childSessionId: string; childRunId: string; model: string; effort?: string; agentId?: string } | null;
      if (info) {
        await this.appendParentEvent(parentEventStore, {
          type: 'subagent_finished',
          runId: context.runId!,
          sessionId: context.sessionId!,
          toolCallId,
          agentType: agentType.id,
          description,
          childSessionId: info.childSessionId,
          childRunId: info.childRunId,
          model: info.model,
          ...(info.agentId ? { agentId: info.agentId } : {}),
          ...(info.effort ? { effort: info.effort } : {}),
          status: 'failed',
          totalTokens: 0,
          toolUseCount: 0,
          turnCount: 0,
          durationMs: 0,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }

    const content = await this.formatOutcome(outcome, context);
    await this.appendParentEvent(parentEventStore, {
      type: 'subagent_finished',
      runId: context.runId!,
      sessionId: context.sessionId!,
      toolCallId,
      agentType: agentType.id,
      description,
      childSessionId: outcome.childSessionId,
      childRunId: outcome.childRunId,
      model: outcome.model,
      ...(outcome.agentId ? { agentId: outcome.agentId } : {}),
      ...(outcome.effort ? { effort: outcome.effort } : {}),
      status: outcome.status,
      totalTokens: outcome.totalTokens,
      toolUseCount: outcome.toolUseCount,
      turnCount: outcome.turnCount,
      durationMs: outcome.durationMs,
      ...(outcome.errorMessage ? {
        errorMessage: customerSafeRuntimeError(outcome.errorMessage, outcome.failureKind),
      } : {}),
      ...(outcome.failureKind ? { failureKind: outcome.failureKind } : {}),
      ...(outcome.recoveryAction ? { recoveryAction: outcome.recoveryAction } : {}),
      ...(outcome.text.trim()
        ? { resultPreview: outcome.text.trim().slice(0, SUBAGENT_RESULT_PREVIEW_CHARS) }
        : {}),
    });

    return {
      content: [
        `[子 Agent 执行信息] agent_id=${outcome.agentId ?? agentId}`
          + ` child_session_id=${outcome.childSessionId} run_id=${outcome.childRunId}`
          + ` model_ref=${outcome.modelRef ?? outcome.model}`
          + ` effort=${outcome.effort ?? 'none'} status=${outcome.status} resumable=true`,
        content,
      ].join('\n\n'),
    };
  }

  private async resolveResumeIdentity(agentId: string, context: ToolCallContext): Promise<PersistedSubagentIdentity> {
    const parentSessionId = context.sessionId ?? context.workspace.sessionId;
    if (!parentSessionId) throw new Error('Agent(resume) 需要当前父 session。');
    const parentSession = await resolveSessionCatalog(this.options.config).get(parentSessionId);
    if (!parentSession || parentSession.deletedAt) throw new Error('Agent(resume) 的父会话不存在或已删除。');
    const caller = context.channelContext.sessionOwner ?? context.channelContext.user;
    const tenantCandidates = [parentSession.tenantId, caller?.tenantId, context.workspace.tenantId]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map(value => value.trim());
    const tenantId = tenantCandidates[0];
    if (!tenantId || tenantCandidates.some(candidate => candidate !== tenantId)) {
      throw new Error('Agent(resume) 的租户上下文缺失或不一致。');
    }
    const userId = parentSession.userId || caller?.id || context.workspace.userId;
    const list = this.options.config.runStore?.listSubagentRunsByAgentId;
    if (!list) throw new Error('当前运行后端未启用 stable agent_id 查询，不能安全续接。');
    const records = await list.call(
      this.options.config.runStore,
      tenantId,
      parentSessionId,
      agentId.trim(),
      { ...(userId ? { userId } : {}), limit: 500 },
    );
    return resolvePersistedSubagentIdentity({
      records,
      agentId: agentId.trim(),
      tenantId,
      parentSessionId,
      ...(userId ? { userId } : {}),
    });
  }

  private assertResumeFields(input: AgentToolInput, identity: PersistedSubagentIdentity): void {
    if (input.agent_type && input.agent_type !== identity.agentType) {
      throw new Error(`resume 的 agent_type 与原身份冲突：${input.agent_type} != ${identity.agentType}`);
    }
    if (input.mode && input.mode !== identity.mode) {
      throw new Error(`resume 的 mode 与原身份冲突：${input.mode} != ${identity.mode}`);
    }
    if (input.include_company_info === true && !identity.includeCompanyInfo) {
      throw new Error('resume 不允许把 include_company_info 从 false 扩权为 true。');
    }
    if (identity.activePhysicalRun) {
      if (input.model && input.model.trim() !== identity.modelRef) {
        throw new Error('子 Agent 正在运行；active resume 只能追加消息，不能切换 model。');
      }
      if (input.effort && input.effort.trim() !== identity.effort) {
        throw new Error('子 Agent 正在运行；active resume 只能追加消息，不能切换 effort。');
      }
    }
  }

  private async trySteerActiveResume(
    identity: PersistedSubagentIdentity,
    prompt: string,
    context: ToolCallContext,
    toolCallId: string,
  ): Promise<ToolResult | null> {
    const target = identity.activePhysicalRun;
    const runStore = this.options.config.runStore;
    if (!target || !runStore?.enqueueUserMessage || !runStore.cancelPendingUserMessage) {
      if (target) throw new Error('当前运行后端未启用 durable steering，不能安全追加消息。');
      return null;
    }
    const parentSessionId = context.sessionId ?? context.workspace.sessionId;
    const parentRunId = context.runId;
    if (!parentSessionId || !parentRunId || !target.tenantId) {
      throw new Error('Agent(active resume) 缺少父会话或目标租户上下文。');
    }
    const caller = context.channelContext.sessionOwner ?? context.channelContext.user;
    const digest = createHash('sha256')
      .update(`subagent-resume:${identity.agentId}:${parentRunId}:${toolCallId}`)
      .digest('hex');
    const messageId = `submsg-${digest.slice(0, 32)}`;
    const acceptedAt = new Date().toISOString();
    const source = await runStore.enqueueUserMessage({
      runId: messageId,
      sessionId: target.sessionId,
      userId: target.userId,
      ...(caller?.id ? { submitterUserId: caller.id } : {}),
      tenantId: target.tenantId,
      model: target.model,
      channel: target.channel ?? 'web',
      executionTarget: target.executionTarget,
      workspaceId: target.workspaceId,
      sandboxScopeId: target.sandboxScopeId,
      idempotencyKey: messageId,
      metadata: {
        subagent: true,
        subagentResumeMessage: true,
        subagentAgentId: identity.agentId,
        subagentMode: identity.mode,
        parentSessionId,
        parentRunId,
        parentToolCallId: toolCallId,
        agentType: identity.agentType,
        description: identity.description,
        modelRef: identity.modelRef,
        ...(identity.effort ? { effort: identity.effort } : {}),
        steeringAcceptedAt: acceptedAt,
        wakeMessage: {
          channel: context.channelContext.channel,
          chatId: target.sessionId,
          content: prompt,
          senderId: caller?.id,
          senderName: caller?.username,
          metadata: { clientMsgId: messageId, subagentAgentId: identity.agentId },
        },
      },
    }, 'steer');
    const targetRunId = typeof source.metadata.steeringTargetRunId === 'string'
      ? source.metadata.steeringTargetRunId : undefined;
    if (targetRunId !== target.runId) {
      await runStore.cancelPendingUserMessage(messageId, 'subagent_active_target_finished');
      return null;
    }
    const delivery = source.metadata.steeringState === 'applied' ? 'applied' : 'accepted';
    return {
      content: JSON.stringify({
        agent_id: identity.agentId,
        child_session_id: target.sessionId,
        run_id: target.runId,
        status: target.status,
        model_ref: identity.modelRef,
        ...(identity.effort ? { effort: identity.effort } : {}),
        message_id: messageId,
        delivery,
        resumable: true,
      }),
    };
  }

  private async tryQueueBackgroundResume(
    identity: PersistedSubagentIdentity,
    prompt: string,
    context: ToolCallContext,
    toolCallId: string,
  ): Promise<ToolResult | null> {
    const task = identity.activeBackgroundTask;
    const queue = this.options.config.runStore?.queueSubagentDeferredMessage;
    if (!task || !queue || !task.tenantId) {
      if (task) throw new Error('当前运行后端未启用后台子 Agent 补充消息队列。');
      return null;
    }
    const parentSessionId = context.sessionId ?? context.workspace.sessionId;
    const parentRunId = context.runId;
    if (!parentSessionId || !parentRunId) throw new Error('Agent(background resume) 缺少父会话上下文。');
    const caller = context.channelContext.sessionOwner ?? context.channelContext.user;
    const digest = createHash('sha256')
      .update(`subagent-resume:${identity.agentId}:${parentRunId}:${toolCallId}`)
      .digest('hex');
    const messageId = `submsg-${digest.slice(0, 32)}`;
    const queued = await queue.call(this.options.config.runStore, {
      taskRunId: task.runId,
      agentId: identity.agentId,
      tenantId: task.tenantId,
      parentSessionId,
      ...(task.userId ? { userId: task.userId } : {}),
      message: {
        messageId,
        prompt,
        acceptedAt: new Date().toISOString(),
        ...(caller?.id ? { senderId: caller.id } : {}),
        ...(caller?.username ? { senderName: caller.username } : {}),
      },
    });
    if (queued.state === 'physical_active') {
      return this.trySteerActiveResume(
        { ...identity, activePhysicalRun: queued.target },
        prompt,
        context,
        toolCallId,
      );
    }
    return {
      content: JSON.stringify({
        agent_id: identity.agentId,
        taskId: task.runId,
        status: task.status,
        resumable: true,
        message_id: messageId,
        delivery: 'accepted',
      }),
    };
  }

  /**
   * D5 回传合约：正文 = 子 run 最后一条 assistant 文本；终态类型化，错误信息与
   * 结论文本严格分离；超长走截断保险丝 + spill 全文到 workspace 附翻页指令。
   */
  private async formatOutcome(outcome: SubagentOutcome, context: ToolCallContext): Promise<string> {
    const meta = outcomeAgentMeta(outcome);
    if (outcome.status !== 'completed') {
      const partial = outcome.text.trim();
      const failureHeader = formatSubagentFailureHeader(outcome, meta);
      return [
        failureHeader,
        partial
          ? `以下为终止前已产出的部分文本（不完整，不可当作最终结论）：\n---\n${await this.truncateWithSpill(partial, outcome, context)}`
          : '（终止前未产出任何文本）',
      ].join('\n');
    }
    const text = outcome.text.trim() || '（子 agent 完成但未产出文本报告）';
    return this.truncateWithSpill(text, outcome, context);
  }

  private async truncateWithSpill(text: string, outcome: SubagentOutcome, context: ToolCallContext): Promise<string> {
    if (text.length <= this.resultMaxChars) return text;
    const truncated = truncateHeadTailByLines(text, this.resultMaxChars);
    // spill 是尽力而为：写失败（只读盘等）不影响截断结果回传
    const spillRelPath = join('assets', 'subagents', `${outcome.childRunId}.md`);
    try {
      await this.spillFullText(text, spillRelPath, context);
      return `${truncated}\n\n[输出超长已截断：完整输出 ${text.length} 字符已保存到 ${spillRelPath}，可用 Read 工具按 offset/limit 翻页查看]`;
    } catch (err) {
      logger.warn(`[subagent] spill 写入失败 child=${outcome.childRunId}: ${err instanceof Error ? err.message : String(err)}`);
      return `${truncated}\n\n[输出超长已截断（完整输出 ${text.length} 字符，spill 落盘失败，仅保留以上节选）]`;
    }
  }

  private async spillFullText(text: string, relPath: string, context: ToolCallContext): Promise<void> {
    await writeTrustedFile(context.workspace.root, relPath, text, {
      encoding: 'utf-8',
      createParents: true,
    });
  }

  private async resolveParentEventStore(context: ToolCallContext): Promise<ParentEventStoreBinding | null> {
    const sessionId = context.sessionId ?? context.workspace.sessionId;
    if (!sessionId) return null;
    try {
      const record = await resolveSessionCatalog(this.options.config).get(sessionId);
      if (!record) return null;
      const sessionTenantId = record.tenantId?.trim();
      const contextTenantId = ((context.channelContext.sessionOwner ?? context.channelContext.user)?.tenantId
        ?? context.workspace.tenantId)?.trim();
      if (sessionTenantId && contextTenantId && sessionTenantId !== contextTenantId) {
        throw new Error(`Subagent parent tenant mismatch for session ${sessionId}`);
      }
      const tenantId = sessionTenantId ?? contextTenantId;
      if (!tenantId) throw new Error(`Subagent parent tenant is missing for session ${sessionId}`);
      return { eventStore: createEventStoreForSession(this.options.config, record), tenantId };
    } catch {
      return null;
    }
  }

  private async appendParentEvent(
    binding: ParentEventStoreBinding | null,
    event: Parameters<EventStore['append']>[0],
  ): Promise<void> {
    if (!binding) return;
    try {
      await binding.eventStore.append(event, { tenantId: binding.tenantId });
    } catch (err) {
      // 观测事件写失败不阻断工具结果回传
      logger.warn(`[subagent] durable 事件写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function outcomeAgentMeta(outcome: SubagentOutcome): string {
  const seconds = Math.max(1, Math.round(outcome.durationMs / 1000));
  return `tokens=${outcome.totalTokens}｜工具调用=${outcome.toolUseCount}｜耗时=${seconds}s｜childSession=${outcome.childSessionId}`;
}

/**
 * 75% head + 25% tail 按行截断（Hermes 方案）：保留开头的结论/结构与结尾的收束，
 * 中间显式标注省略量，绝不静默截断。
 */
export function truncateHeadTailByLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const headBudget = Math.floor(maxChars * 0.75);
  const tailBudget = maxChars - headBudget;

  const headLines: string[] = [];
  let headChars = 0;
  let headEnd = 0;
  for (; headEnd < lines.length; headEnd++) {
    const cost = lines[headEnd]!.length + 1;
    if (headChars + cost > headBudget) break;
    headLines.push(lines[headEnd]!);
    headChars += cost;
  }

  const tailLines: string[] = [];
  let tailChars = 0;
  let tailStart = lines.length;
  for (let i = lines.length - 1; i > headEnd; i--) {
    const cost = lines[i]!.length + 1;
    if (tailChars + cost > tailBudget) break;
    tailLines.unshift(lines[i]!);
    tailChars += cost;
    tailStart = i;
  }

  const omitted = Math.max(0, tailStart - headEnd);
  return [
    ...headLines,
    `……[中间省略 ${omitted} 行，共 ${text.length} 字符]……`,
    ...tailLines,
  ].join('\n');
}

/** 限额动态渲染进工具描述（D6/D9：模型可见文案与运行时常量单一来源）。 */
function renderAgentToolDescription(): string {
  const typeList = Object.values(SUBAGENT_TYPES)
    .map((type) => `${type.id}（${type.description}）`)
    .join('；');
  return loadToolDescription('Agent')
    .replace('{{AGENT_TYPES}}', typeList)
    .replace('{{PER_RUN_CONCURRENCY}}', String(SUBAGENT_PER_RUN_MAX_CONCURRENCY))
    .replace('{{MAX_TURNS}}', String(SUBAGENT_MAX_TURNS))
    .replace('{{TIMEOUT_MINUTES}}', String(Math.round(SUBAGENT_HARD_TIMEOUT_MS / 60_000)));
}
