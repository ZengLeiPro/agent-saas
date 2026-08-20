import { describe, expect, it } from 'vitest';
import {
  projectBusinessStepEvents,
  projectWorkflowTrace,
  workflowTraceV1Schema,
} from '@agent/shared';
import { makeWorkflowScenario } from '../workflowTestFixtures';
import { getReplayScript } from './registry';
import {
  buildTechnicalInquiryTraceScript,
  TECHNICAL_INQUIRY_TRACE_SCENARIO_ID,
} from './technicalInquiryTraceScript';

function scenario() {
  return makeWorkflowScenario(TECHNICAL_INQUIRY_TRACE_SCENARIO_ID, {
    workflowId: 'technical-inquiry-to-approved-quote-loop',
    title: '复杂询价推进到批准报价和订单',
    launch: {
      sampleAvailable: false,
      startMode: 'chat',
      entry: { kind: 'business_event', content: '客户询价中的消息和附件规格不一致。' },
      starterMessage: '请处理这条复杂询价。',
    },
  });
}

function visibleEvents(script: ReturnType<typeof buildTechnicalInquiryTraceScript>, count: number) {
  return [
    ...(script.traceEntryEvents ?? []),
    ...script.steps.slice(0, count).flatMap((step) => step.trace?.events ?? []),
  ];
}

describe('复杂询价 Workflow Trace Hero', () => {
  it('直接迁移现有 8 步场景，3 个审批点全部由 gate 事件表达', () => {
    const script = buildTechnicalInquiryTraceScript(scenario());
    expect(script.steps).toHaveLength(8);
    expect(script.steps.every((step) => step.blocks.length === 0)).toBe(true);
    expect(script.steps.filter((step) => step.trace?.events.some((event) => event.type === 'gate_requested'))).toHaveLength(3);
    expect(script.steps.flatMap((step) => step.trace?.events ?? []).every((event) => event.authority === 'simulation')).toBe(true);

    const approvedPath = [
      ...(script.traceEntryEvents ?? []),
      ...script.steps.flatMap((step) => [
        ...(step.trace?.events ?? []),
        ...(step.trace?.approvedEvents ?? []),
      ]),
    ];
    expect(workflowTraceV1Schema.safeParse({
      schemaVersion: 1,
      workflowId: 'technical-inquiry-to-approved-quote-loop',
      instanceId: 'simulation-technical-inquiry-quote-001',
      events: approvedPath,
    }).success).toBe(true);
  });

  it('第一步同一事件前缀同时生成业务计划、第 1/8 步与右侧来源面板', () => {
    const script = buildTechnicalInquiryTraceScript(scenario());
    const projection = projectWorkflowTrace(visibleEvents(script, 1));
    const business = projectBusinessStepEvents(projection.messages, false);

    expect(business.events.map((event) => event.kind)).toEqual(['plan', 'start', 'complete']);
    expect(business.events.find((event) => event.kind === 'plan')?.stepCount).toBe(8);
    expect(business.events.find((event) => event.kind === 'complete')?.stepIndex).toBe(1);
    const completed = business.events.find((event) => event.kind === 'complete');
    expect(completed?.todo?.outcome?.text).toContain('规格冲突');
    expect(completed?.todo?.display).toContainEqual({
      kind: 'records',
      layout: 'comparison',
      title: '核对规格来源',
      items: [{
        label: '防护等级',
        baseline: '客户消息 · IP67',
        current: '询价附件 · IP65',
        delta: '不一致，停止报价',
        tone: 'danger',
        note: '两个来源均保留，等待客户澄清后再继续报价',
      }],
    });
    expect(projection.panel?.activeView).toBe('source');
    expect(projection.panel?.foot).toContain('演示来源');
    expect(projection.panel?.foot).not.toContain('已连接');
  });

  it('批准分支追加 effect 与步骤终态，退回分支只进入 waiting 且没有发送 effect', () => {
    const script = buildTechnicalInquiryTraceScript(scenario());
    const step = script.steps[1];
    const prefix = [
      ...visibleEvents(script, 1),
      ...(step.trace?.events ?? []),
    ];
    const approved = projectWorkflowTrace([...prefix, ...(step.trace?.approvedEvents ?? [])]);
    const rejected = projectWorkflowTrace([...prefix, ...(step.trace?.rejectedEvents ?? [])]);

    expect(approved.events.some((event) => event.type === 'effect' && event.effectId === 'clarification-message')).toBe(true);
    expect(approved.pendingGate).toBeNull();
    expect(rejected.events.some((event) => event.type === 'effect' && event.effectId === 'clarification-message')).toBe(false);
    const rejectedBusiness = projectBusinessStepEvents(rejected.messages, false);
    expect(rejectedBusiness.events.at(-1)?.kind).toBe('wait');
    expect(rejectedBusiness.events.at(-1)?.todo?.outcome?.text).toContain('未写入');
  });

  it('目标 Hero 保留旧 presentation 元数据，其余 presentation 场景仍走旧 fallback', () => {
    const target = scenario();
    expect(getReplayScript(target.id, target)?.traceEntryEvents).toBeUndefined();

    const legacy = makeWorkflowScenario('legacy-presentation', {
      presentation: {
        version: 1,
        dataLabel: '合成场景演示',
        limitation: '演示数据均为示例。',
        chapters: [{
          id: 'read',
          title: '读取状态',
          narration: '读取业务状态。',
          result: '状态已读取。',
          interaction: { kind: 'next', label: '完成' },
          surface: { kind: 'crm_table', title: 'CRM', items: [{ label: '状态', value: '已读取', state: 'success' }] },
        }],
      },
    });
    const fallback = getReplayScript(legacy.id, legacy);
    expect(fallback?.traceEntryEvents).toBeUndefined();
    expect(fallback?.steps[0].blocks.some((block) => block.presentation?.panelBase)).toBe(true);
  });
});
