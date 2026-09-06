/**
 * 回放投影 —— 剧本（纯数据）到会话消息的唯一转换路径。
 *
 * Web 与移动端共用：两端都走 `mapSessionDetailToMessages`，也就是真实会话的同一条
 * 映射链，演示能表达的形态因此永远等于真实会话能表达的形态。平台差异只留在渲染层
 * （右侧系统面板、产物预览策略、打字机节奏），不允许各自实现一套「剧本→消息」。
 */
import { mapSessionDetailToMessages } from '../../lib/sessionsApi';
import type { ApiSessionDetail, ApiTranscriptBlock, MessageItem } from '../../types';
import type {
  WorkflowTraceEventV1,
  WorkflowTraceGateRequestedEventV1,
} from '../../schemas/workflowTrace';
import { buildLegacyReplayBlocks } from './legacyTaskDemo';
import type { ReplayScript, ReplayStep } from './types';

export type ReplayDecision = 'approved' | 'rejected';
export type ReplayDecisionMap = Record<number, ReplayDecision>;

/** 剧本回放不落库，会话标识固定；stats 与真实详情同形，避免映射走进缺字段分支。 */
export function buildReplayDetail(blocks: ApiTranscriptBlock[]): ApiSessionDetail {
  return {
    sessionId: 'scenario-replay',
    stats: { lines: blocks.length, parsedLines: blocks.length, parseErrors: 0 },
    blocks,
  };
}

/** Trace V1 剧本按已推进步数累积事件；批准与退回各自追加自己的后续事实。 */
export function collectReplayTraceEvents(
  script: ReplayScript,
  stepIndex: number,
  decisions: ReplayDecisionMap,
): WorkflowTraceEventV1[] {
  const events = [...(script.traceEntryEvents ?? [])];
  for (const [index, step] of script.steps.slice(0, stepIndex).entries()) {
    if (!step.trace) continue;
    events.push(...step.trace.events);
    if (decisions[index] === 'approved') events.push(...(step.trace.approvedEvents ?? []));
    if (decisions[index] === 'rejected') events.push(...(step.trace.rejectedEvents ?? []));
  }
  return events;
}

export interface ReplayApproval {
  title: string;
  description: string;
  facts: Array<{ label: string; value: string }>;
  approveLabel: string;
  rejectLabel?: string;
}

/** 人审既可写在剧本步骤上，也可来自 Trace V1 的 gate 事件；两者归一为同一份阻断参数。 */
export function resolveReplayApproval(step?: ReplayStep): ReplayApproval | undefined {
  if (!step) return undefined;
  if (step.approval) return step.approval;
  const gate = step.trace?.events.find(
    (event): event is WorkflowTraceGateRequestedEventV1 => event.type === 'gate_requested',
  );
  if (!gate) return undefined;
  return {
    title: gate.title,
    description: gate.description,
    facts: gate.facts,
    approveLabel: gate.approveLabel,
    ...(gate.rejectLabel ? { rejectLabel: gate.rejectLabel } : {}),
  };
}

export interface LegacyReplayProjectionOptions {
  /** 打字机等平台节奏在投影前改写块内容；不传则整块直接呈现。 */
  transformBlocks?: (blocks: ApiTranscriptBlock[]) => ApiTranscriptBlock[];
  /** 正在逐字输出的文本块 id，映射后标记 streaming。 */
  streamingBlockId?: string;
}

/**
 * 非 Trace 剧本的消息投影。
 *
 * `replayInstant` 的文本块是回放旁白（例如「三天后」），真实会话里对应系统事件，
 * 因此映射后改成 system_event，不伪装成 Agent 回复。
 */
export function projectLegacyReplayMessages(
  script: ReplayScript,
  stepIndex: number,
  decisions: ReplayDecisionMap,
  options: LegacyReplayProjectionOptions = {},
): MessageItem[] {
  const source = buildLegacyReplayBlocks(script, stepIndex, decisions);
  const blocks = options.transformBlocks ? options.transformBlocks(source) : source;
  const mapped = blocks.length ? mapSessionDetailToMessages(buildReplayDetail(blocks)) : [];
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  return mapped.map((message) => {
    const sourceBlock = blockById.get(message.id);
    if (message.type === 'text' && sourceBlock?.kind === 'text' && sourceBlock.replayInstant) {
      return {
        id: message.id,
        type: 'system_event' as const,
        title: sourceBlock.title,
        content: sourceBlock.content,
        timestamp: message.timestamp,
      };
    }
    return message.type === 'text' && message.id === options.streamingBlockId
      ? { ...message, streaming: true }
      : message;
  });
}
