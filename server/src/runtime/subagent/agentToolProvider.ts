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

import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

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
import { getSubagentType, SUBAGENT_TYPES } from './agentTypes.js';
import {
  SUBAGENT_HARD_TIMEOUT_MS,
  SUBAGENT_MAX_TURNS,
  SUBAGENT_PER_RUN_MAX_CONCURRENCY,
  SUBAGENT_PER_RUN_MAX_TOTAL,
  SUBAGENT_RESULT_MAX_CHARS,
  type SubagentLimiter,
} from './subagentLimits.js';
import { runSubagent, type SubagentOutcome } from './subagentRunner.js';

const logger = createLogger('AgentToolProvider');
const SUBAGENT_RESULT_PREVIEW_CHARS = 2_000;

const agentToolSchema = z.object({
  description: z.string().min(1).max(120)
    .describe('简短任务摘要（3-5 个词），子 agent 运行期间显示在 UI 上。'),
  prompt: z.string().min(1)
    .describe('交给子 agent 的完整自包含任务。它看不到本对话；必须写入全部背景、约束与期望的报告格式。'),
  agent_type: z.enum(['general', 'explore']).optional().default('general')
    .describe('general = 全量工具执行者；explore = 只读侦察（Read/Glob/Grep/WebSearch/WebFetch/MemorySearch）。'),
  model: z.string().optional()
    .describe('可选，覆盖模型 ref（必须是本租户允许的模型）。省略则继承父模型。'),
  include_company_info: z.boolean().optional().default(false)
    .describe('仅 general 有效：把租户公司信息注入子 agent 的系统提示词。'),
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
      description: renderAgentToolDescription(),
      schema: agentToolSchema,
      risk: 'safe',
      approvalMode: 'never',
      auditCategory: 'agent.subagent',
      category: 'core',
      label: '子 Agent 调度',
    };
  }

  list(): ToolDescriptor[] {
    return [this.descriptor];
  }

  async invoke<TInput>(call: AuthorizedToolCall<TInput>, context: ToolCallContext): Promise<ToolResult | undefined> {
    if (call.toolId !== this.descriptor.id) return undefined;
    const input = this.descriptor.schema.parse(call.input) as AgentToolInput;
    const agentType = getSubagentType(input.agent_type);
    if (!agentType) {
      throw new Error(`未知的 agent_type: ${input.agent_type}（可用：${Object.keys(SUBAGENT_TYPES).join(' / ')}）`);
    }
    const toolCallId = context.toolCallId ?? `agent-${randomUUID()}`;

    // 父 session event store：durable subagent_started/finished 的落点。
    // 解析失败（file backend 测试 fixture 等）不阻断执行，只丢观测事件。
    const parentEventStore = await this.resolveParentEventStore(context);
    const parentTenantId = (context.channelContext.sessionOwner ?? context.channelContext.user)?.tenantId
      ?? context.workspace.tenantId;

    let startedInfo: { childSessionId: string; childRunId: string; model: string } | null = null;
    const appendStarted = async (info: { childSessionId: string; childRunId: string; model: string }): Promise<void> => {
      startedInfo = info;
      await this.appendParentEvent(parentEventStore, parentTenantId, {
        type: 'subagent_started',
        runId: context.runId!,
        sessionId: context.sessionId!,
        toolCallId,
        agentType: agentType.id,
        description: input.description,
        childSessionId: info.childSessionId,
        childRunId: info.childRunId,
        model: info.model,
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
          description: input.description,
          prompt: input.prompt,
          ...(input.model ? { model: input.model } : {}),
          includeCompanyInfo: input.include_company_info === true,
        },
        ...(this.options.limiter ? { limiter: this.options.limiter } : {}),
        ...(this.options.hardTimeoutMs !== undefined ? { hardTimeoutMs: this.options.hardTimeoutMs } : {}),
        onChildRunCreated: appendStarted,
      });
    } catch (err) {
      // started 已发但 runner 异常出逃（装配层错误）：补一条 finished(failed)，
      // 不让前端 SubagentBlock 永远停在 running。前置校验失败（未发 started）直接透传，
      // 由 invokeAuthorizedTool 转成标准化工具错误文本。
      const info = startedInfo as { childSessionId: string; childRunId: string; model: string } | null;
      if (info) {
        await this.appendParentEvent(parentEventStore, parentTenantId, {
          type: 'subagent_finished',
          runId: context.runId!,
          sessionId: context.sessionId!,
          toolCallId,
          agentType: agentType.id,
          description: input.description,
          childSessionId: info.childSessionId,
          childRunId: info.childRunId,
          model: info.model,
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

    await this.appendParentEvent(parentEventStore, parentTenantId, {
      type: 'subagent_finished',
      runId: context.runId!,
      sessionId: context.sessionId!,
      toolCallId,
      agentType: agentType.id,
      description: input.description,
      childSessionId: outcome.childSessionId,
      childRunId: outcome.childRunId,
      model: outcome.model,
      status: outcome.status,
      totalTokens: outcome.totalTokens,
      toolUseCount: outcome.toolUseCount,
      turnCount: outcome.turnCount,
      durationMs: outcome.durationMs,
      ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
      ...(outcome.text.trim()
        ? { resultPreview: outcome.text.trim().slice(0, SUBAGENT_RESULT_PREVIEW_CHARS) }
        : {}),
    });

    return { content: await this.formatOutcome(outcome, context) };
  }

  /**
   * D5 回传合约：正文 = 子 run 最后一条 assistant 文本；终态类型化，错误信息与
   * 结论文本严格分离；超长走截断保险丝 + spill 全文到 workspace 附翻页指令。
   */
  private async formatOutcome(outcome: SubagentOutcome, context: ToolCallContext): Promise<string> {
    const meta = outcomeAgentMeta(outcome);
    if (outcome.status !== 'completed') {
      const partial = outcome.text.trim();
      return [
        `[子 agent 异常终止] status=${outcome.status}｜${outcome.errorMessage ?? '未知错误'}｜${meta}`,
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
    const fullPath = join(context.workspace.root, relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, text, 'utf-8');
  }

  private async resolveParentEventStore(context: ToolCallContext): Promise<EventStore | null> {
    const sessionId = context.sessionId ?? context.workspace.sessionId;
    if (!sessionId) return null;
    try {
      const record = await resolveSessionCatalog(this.options.config).get(sessionId);
      if (!record) return null;
      return createEventStoreForSession(this.options.config, record);
    } catch {
      return null;
    }
  }

  private async appendParentEvent(
    eventStore: EventStore | null,
    tenantId: string | undefined,
    event: Parameters<EventStore['append']>[0],
  ): Promise<void> {
    if (!eventStore) return;
    try {
      await eventStore.append(event, tenantId ? { tenantId } : undefined);
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
    .replace('{{PER_RUN_TOTAL}}', String(SUBAGENT_PER_RUN_MAX_TOTAL))
    .replace('{{PER_RUN_CONCURRENCY}}', String(SUBAGENT_PER_RUN_MAX_CONCURRENCY))
    .replace('{{MAX_TURNS}}', String(SUBAGENT_MAX_TURNS))
    .replace('{{TIMEOUT_MINUTES}}', String(Math.round(SUBAGENT_HARD_TIMEOUT_MS / 60_000)));
}
