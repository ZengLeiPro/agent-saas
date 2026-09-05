import { describe, expect, it } from 'vitest';
import type { CatalogScenarioPublic } from '@agent/shared';
import {
  buildScenarioReplayScript,
  hasScenarioReplay,
  replayMessagesUpTo,
  replayStepRequiresApproval,
} from './replayScript';

function scenario(overrides: Partial<CatalogScenarioPublic> = {}): CatalogScenarioPublic {
  return {
    id: 'catalog-demo-loop',
    workflowId: 'wf-demo',
    roleViewIds: [],
    title: '示例工作流',
    value: '把散落的业务事实收敛成可核对的结果',
    shortChain: ['接事件', '读事实', '出结果'],
    roleIds: ['role-sales'],
    industryTags: ['manufacturing'],
    industryVerticals: [],
    businessModels: [],
    maturityLevels: ['已有单体系统'],
    goalTags: ['保交付'],
    triggerBadge: '客户催单时',
    actionBadge: '生成交付说明',
    humanApprovalSummary: '外发前需主管确认',
    detail: {
      event: '客户催单',
      reads: ['订单表', '发货记录'],
      decides: '判断能否按期交付，缺口在哪一环',
      acts: ['生成交付说明', '同步给客户群'],
      approval: '外发内容需主管确认',
      beforeAfter: '客户拿到明确的交付时间',
      followUp: '到期回读物流状态',
      valueProof: '催单响应时长从 1 天降到 10 分钟',
    },
    launch: {
      sampleAvailable: true,
      startMode: 'chat',
      entry: { kind: 'business_event', content: '客户在群里问这单什么时候到' },
      starterMessage: '帮我看看这单交付情况',
    },
    primaryType: 'LOOP',
    readiness: 'D0_CURRENT',
    cta: { primary: '立即试一试' },
    featured: false,
    ...overrides,
  } as CatalogScenarioPublic;
}

describe('场景回放剧本注册表', () => {
  it('目录场景都可回放：自带 presentation 或可按公开定义合成', () => {
    expect(hasScenarioReplay(scenario())).toBe(true);
    expect(
      hasScenarioReplay(
        scenario({
          detail: { ...scenario().detail, reads: [] },
        }),
      ),
    ).toBe(false);
  });

  it('无 presentation 时合成 6 章 quick 剧本，内容全部来自公开业务定义', () => {
    const script = buildScenarioReplayScript(scenario());
    expect(script.mode).toBe('quick');
    expect(script.dataLabel).toBe('合成场景演示');
    expect(script.limitation).toContain('不会连接或写入你的真实业务系统');
    expect(script.chapters).toHaveLength(6);
    expect(script.chapters.map((chapter) => chapter.id)).toEqual([
      'quick-event',
      'quick-read',
      'quick-decide',
      'quick-approve',
      'quick-act',
      'quick-verify',
    ]);
    expect(script.chapters[0].surface.items[0].value).toBe('客户在群里问这单什么时候到');
    expect(script.chapters[1].surface.items.map((item) => item.value)).toEqual([
      '订单表',
      '发货记录',
    ]);
  });

  it('自带 presentation 时直接采用服务端章节（hero）', () => {
    const chapters = Array.from({ length: 6 }, (_, index) => ({
      id: `chapter-${index}`,
      title: `第 ${index} 章`,
      narration: '叙述',
      result: '结果',
      interaction: { kind: 'next' as const, label: '下一步' },
      surface: {
        kind: 'summary' as const,
        title: '面板',
        items: [{ label: '字段', value: '值', state: 'success' as const }],
      },
    }));
    const script = buildScenarioReplayScript(
      scenario({
        presentation: {
          version: 1,
          dataLabel: '合成场景演示',
          limitation: '示例数据',
          chapters,
        },
      }),
    );
    expect(script.mode).toBe('hero');
    expect(script.chapters).toHaveLength(6);
    expect(script.chapters[0].id).toBe('chapter-0');
  });

  it('confirm 章节阻断推进（人审是工作流的一部分）', () => {
    const script = buildScenarioReplayScript(scenario());
    expect(replayStepRequiresApproval(script, 3)).toBe(true);
    expect(replayStepRequiresApproval(script, 0)).toBe(false);
    expect(replayStepRequiresApproval(script, 99)).toBe(false);
  });

  it('投影成真实会话消息：每章 3 条（叙述 / 面板 / 结果），并按步累加', () => {
    const script = buildScenarioReplayScript(scenario());
    const first = replayMessagesUpTo(script, 0, { entryContent: '客户催单' });
    expect(first).toHaveLength(4);
    expect(first[0].type).toBe('user');
    expect(first[1].type).toBe('text');
    expect(first[2].type).toBe('tool_use');
    expect(first[3].type).toBe('text');

    const second = replayMessagesUpTo(script, 1, { entryContent: '客户催单' });
    expect(second).toHaveLength(7);
    // 累加不替换：已推进的章节保持在时间线上
    expect(second.slice(0, 4).map((item) => item.id)).toEqual(first.map((item) => item.id));

    const noEntry = replayMessagesUpTo(script, 0);
    expect(noEntry).toHaveLength(3);
    expect(new Set(noEntry.map((item) => item.id)).size).toBe(3);
  });

  it('面板行按章节 state 映射到真实摘要行变体', () => {
    const script = buildScenarioReplayScript(scenario());
    const messages = replayMessagesUpTo(script, 3);
    const approval = messages.find((item) => item.id.includes('quick-approve-surface'));
    expect(approval?.type).toBe('tool_use');
    if (approval?.type !== 'tool_use') throw new Error('回放面板块缺失');
    expect(approval.presentation?.status).toBe('waiting');
    expect(approval.presentation?.detail?.[0]).toEqual({
      verdict: 'pending',
      text: '确认边界：外发内容需主管确认',
    });
  });
});
