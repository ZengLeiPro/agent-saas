/**
 * Hero 回放剧本 —— 移动端接入 Web 同一份手写剧本。
 *
 * 剧本自身已下沉 `shared/src/scenarios/replay/`，两端消费同一批数据、同一条
 * 「剧本 → ApiTranscriptBlock → mapSessionDetailToMessages → MessageList」投影
 * （`replayProjection`）。移动端与 Web 的差别只在渲染外壳：没有右侧企业系统面板，
 * 产物 HTML 仍按移动端既有策略走 Artifact 交付，不为演示另开预览通道。
 *
 * 目录里没有手写剧本的场景，仍回落到 `replayScript.ts` 的章节合成演示。
 */
import { projectWorkflowTrace } from '@agent/shared';
import type { CatalogScenarioPublic, MessageItem } from '@agent/shared';
import { loadLazyReplayScript } from '@agent/shared/scenarios/replay/lazyRegistry';
import { getReplayScript } from '@agent/shared/scenarios/replay/registry';
import {
  collectReplayTraceEvents,
  projectLegacyReplayMessages,
  resolveReplayApproval,
} from '@agent/shared/scenarios/replay/replayProjection';
import type {
  ReplayApproval,
  ReplayDecisionMap,
} from '@agent/shared/scenarios/replay/replayProjection';
import { TECHNICAL_INQUIRY_TRACE_SCENARIO_ID } from '@agent/shared/scenarios/replay/technicalInquiryTraceMeta';
import type { ReplayScript } from '@agent/shared/scenarios/replay/types';

export type { ReplayApproval, ReplayDecisionMap };
export type { ReplayScript };

/**
 * 取该场景的手写剧本：先查同步注册表，再按需装载大体积剧本，
 * Trace V1 剧本与 Web 同款特判（它由场景公开定义现场构造）。
 * 没有手写剧本时返回 null，调用方回落章节合成演示。
 */
export async function loadHeroReplayScript(
  scenario: CatalogScenarioPublic,
): Promise<ReplayScript | null> {
  if (scenario.id === TECHNICAL_INQUIRY_TRACE_SCENARIO_ID) {
    const module = await import('@agent/shared/scenarios/replay/technicalInquiryTraceScript');
    return module.buildTechnicalInquiryTraceScript(scenario);
  }
  const direct = getReplayScript(scenario.id);
  if (direct) return direct;
  return (await loadLazyReplayScript(scenario.id)) ?? null;
}

/** 已推进到 `stepIndex` 时应显示的会话消息；Trace 剧本走同一条 projector。 */
export function heroReplayMessages(
  script: ReplayScript,
  stepIndex: number,
  decisions: ReplayDecisionMap,
): MessageItem[] {
  if (script.traceEntryEvents) {
    return projectWorkflowTrace(collectReplayTraceEvents(script, stepIndex, decisions)).messages;
  }
  return projectLegacyReplayMessages(script, stepIndex, decisions);
}

export interface HeroReplayStepState {
  /** 剧本总步数；stepIndex 0 表示只显示入口，尚未推进第一步。 */
  total: number;
  atEnd: boolean;
  /** 回放条上的当前步说明；结束后显示收尾文案。 */
  caption: string;
  /** 当前步需要有权人确认时的阻断参数（剧本 approval 或 Trace gate 事件）。 */
  approval?: ReplayApproval;
  /** 当前步已作出的决定；未决定时为 undefined。 */
  decision?: 'approved' | 'rejected';
  /** 未批准前不允许推进——演示同样不跳过人审。 */
  blocked: boolean;
}

export function heroReplayStepState(
  script: ReplayScript,
  stepIndex: number,
  decisions: ReplayDecisionMap,
): HeroReplayStepState {
  const total = script.steps.length;
  const currentIndex = stepIndex - 1;
  const currentStep = currentIndex >= 0 ? script.steps[currentIndex] : undefined;
  const approval = resolveReplayApproval(currentStep);
  const decision = currentIndex >= 0 ? decisions[currentIndex] : undefined;
  return {
    total,
    atEnd: stepIndex >= total,
    caption: stepIndex >= total ? '演示结束' : (script.steps[stepIndex]?.caption ?? ''),
    ...(approval ? { approval } : {}),
    ...(decision ? { decision } : {}),
    blocked: Boolean(approval) && decision !== 'approved',
  };
}
