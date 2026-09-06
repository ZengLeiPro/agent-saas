import { describe, expect, it } from 'vitest';

import { makeWorkflowScenario } from '@agent/shared/scenarios/workflowTestFixtures';
import { knowledgeQaScript } from '@agent/shared/scenarios/replay/knowledgeQaScript';
import { TECHNICAL_INQUIRY_TRACE_SCENARIO_ID } from '@agent/shared/scenarios/replay/technicalInquiryTraceMeta';
import type { ReplayScript } from '@agent/shared/scenarios/replay/types';

import { heroReplayMessages, heroReplayStepState, loadHeroReplayScript } from './heroReplay';

describe('heroReplay', () => {
  it('同步注册表里的手写剧本直接命中', async () => {
    const script = await loadHeroReplayScript(makeWorkflowScenario(knowledgeQaScript.scenarioId));
    expect(script?.scenarioId).toBe(knowledgeQaScript.scenarioId);
  });

  it('大体积 hook 剧本按需装载', async () => {
    const script = await loadHeroReplayScript(makeWorkflowScenario('catalog-hook-boss-top-risks'));
    expect(script?.scenarioId).toBe('catalog-hook-boss-top-risks');
    expect(script?.steps.length).toBeGreaterThan(0);
  });

  it('Trace V1 剧本按场景公开定义现场构造', async () => {
    const script = await loadHeroReplayScript(
      makeWorkflowScenario(TECHNICAL_INQUIRY_TRACE_SCENARIO_ID, {
        workflowId: 'technical-inquiry-to-approved-quote-loop',
        title: '复杂询价推进到批准报价和订单',
      }),
    );
    expect(script?.traceEntryEvents?.length).toBeGreaterThan(0);
    // Trace 剧本走同一条 projector，不落回 blocks 分支。
    expect(heroReplayMessages(script!, 1, {}).length).toBeGreaterThan(0);
  });

  it('没有手写剧本的场景返回 null，由章节合成演示兜底', async () => {
    await expect(
      loadHeroReplayScript(makeWorkflowScenario('catalog-not-a-real-scenario')),
    ).resolves.toBeNull();
  });

  it('未推进时只显示入口，推进后消息增多', () => {
    const entry = heroReplayMessages(knowledgeQaScript, 0, {});
    expect(entry).toHaveLength(1);
    expect(heroReplayMessages(knowledgeQaScript, 1, {}).length).toBeGreaterThan(1);
  });

  it('人审步骤在批准前阻断推进，批准后放行，退回保留决定', async () => {
    const script = await loadHeroReplayScript(makeWorkflowScenario('catalog-hook-boss-top-risks'));
    if (!script) throw new Error('未注册 hook 剧本');
    const approvalStepIndex = script.steps.findIndex((step) => step.approval);
    expect(approvalStepIndex).toBeGreaterThanOrEqual(0);
    const atApproval = heroReplayStepState(script, approvalStepIndex + 1, {});
    expect(atApproval.approval).toBeDefined();
    expect(atApproval.blocked).toBe(true);
    expect(
      heroReplayStepState(script, approvalStepIndex + 1, {
        [approvalStepIndex]: 'approved',
      }).blocked,
    ).toBe(false);
    const rejected = heroReplayStepState(script, approvalStepIndex + 1, {
      [approvalStepIndex]: 'rejected',
    });
    expect(rejected.decision).toBe('rejected');
    expect(rejected.blocked).toBe(true);
  });

  it('走到末步时给出收尾文案，未到末步给当前步说明', () => {
    const total = knowledgeQaScript.steps.length;
    expect(heroReplayStepState(knowledgeQaScript, 0, {}).caption).toBe(
      knowledgeQaScript.steps[0]!.caption,
    );
    const end = heroReplayStepState(knowledgeQaScript, total, {});
    expect(end).toMatchObject({ atEnd: true, caption: '演示结束', total });
  });

  it('剧本本身不带审批的步骤不阻断', () => {
    const script: ReplayScript = {
      scenarioId: 'unit',
      title: '无审批',
      steps: [{ caption: '唯一一步', blocks: [] }],
      sources: [],
    };
    expect(heroReplayStepState(script, 1, {}).blocked).toBe(false);
  });
});
