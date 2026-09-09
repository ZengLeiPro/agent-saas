import { describe, expect, it } from 'vitest';

import { makeGroupBinding } from '../__tests__/agentDwsAccountsRoutes.fixtures.js';
import {
  buildAgentDwsEffectiveConfigPreview,
  type AgentDwsEffectiveConfigComputation,
} from './agentDwsEffectiveConfigPreview.js';

function computation(): AgentDwsEffectiveConfigComputation {
  return {
    publishedAgent: {
      skillIds: ['skill-secret-a', 'skill-secret-b'],
      knowledgeSkillIds: ['knowledge-skill-secret'],
      sourceIds: ['source-secret-a', 'source-secret-b'],
      executionMode: 'dispatcher',
      enabled: true,
    },
    channelCeiling: {
      toolNames: ['ContextGet', 'ContextSearch', 'WebSearch'],
      contextSourceIds: ['source-secret-a', 'source-secret-b'],
      contextDirectoryAvailable: true,
    },
    groupNarrowing: makeGroupBinding().effectiveConfig,
    liveOverrides: { bindingEnabled: true, liveDeny: false, accountStatus: 'active' },
  };
}

describe('Agent DWS effective config preview', () => {
  it('返回准确命名的三层摘要、最终缩小范围且不暴露内部 ID', () => {
    const source = computation();
    const binding = makeGroupBinding({
      effectiveConfig: {
        ...makeGroupBinding().effectiveConfig,
        instructions: { system: '只处理本群事项' },
        knowledge: { contextEnabled: true, sourceIds: ['source-secret-a'] },
        capabilities: {
          skillIds: ['skill-secret-a'],
          toolNames: ['ContextGet', 'ContextSearch'],
          dwsResourceIds: [],
        },
      },
    });
    source.groupNarrowing = binding.effectiveConfig;

    const preview = buildAgentDwsEffectiveConfigPreview(source, binding);

    expect(preview.layers.map((layer) => layer.label)).toEqual([
      '当前发布值',
      '渠道上限',
      '会话已保存值',
    ]);
    expect(preview.effective).toMatchObject({
        label: '当前生效范围',
      status: 'available',
      instructionsConfigured: true,
      contextEnabled: true,
      frontdesk: { status: 'available', skillCount: 1, toolCount: 2, sourceCount: 1 },
      worker: {
        status: 'task_compile_required',
        skillCount: 1,
        sourceCount: 1,
        dwsResourceCount: 0,
      },
      completion: '回复原会话',
      taskVisibility: '群内可见',
    });
    expect(preview.warnings.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'conversation.skills_narrowed',
        'conversation.tools_narrowed',
        'conversation.sources_narrowed',
        'conversation.full_snapshot',
      ]),
    );
    expect(JSON.stringify(preview)).not.toMatch(/secret-a|secret-b|knowledge-skill-secret/);
  });

  it('明确展示渠道不可用与 live deny，不误报为继承恢复能力', () => {
    const source = computation();
    source.channelCeiling.contextDirectoryAvailable = false;
    source.liveOverrides = { ...source.liveOverrides, liveDeny: true };
    const binding = makeGroupBinding({
      policy: { ...makeGroupBinding().policy, liveDeny: true },
      effectiveConfig: {
        ...makeGroupBinding().effectiveConfig,
        knowledge: { contextEnabled: true, sourceIds: ['source-secret-a'] },
      },
    });
    source.groupNarrowing = binding.effectiveConfig;

    const preview = buildAgentDwsEffectiveConfigPreview(source, binding);

    expect(preview.warnings.map((item) => item.code)).toEqual(
      expect.arrayContaining(['channel.context_unavailable', 'conversation.live_deny']),
    );
    expect(
      preview.warnings.find((item) => item.code === 'conversation.full_snapshot')?.message,
    ).toContain('不表示未填写项会自动恢复继承');
  });
});
