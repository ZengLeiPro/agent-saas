import type {
  AgentDwsConfigPreview,
  AgentDwsConfigPreviewWarning,
} from '@agent/shared/types/agentDwsAccount';

import type { OrgAgentChannelBinding } from '../data/orgGroupAgents/index.js';

export interface AgentDwsEffectiveConfigComputation {
  publishedAgent: {
    skillIds: string[];
    knowledgeSkillIds: string[];
    sourceIds: string[];
    executionMode: string;
    enabled: boolean;
  };
  channelCeiling: {
    toolNames: string[];
    contextSourceIds: string[];
    contextDirectoryAvailable: boolean;
  };
  groupNarrowing: OrgAgentChannelBinding['effectiveConfig'];
  liveOverrides: {
    bindingEnabled: boolean;
    liveDeny: boolean;
    accountStatus: string;
  };
}

export function buildAgentDwsEffectiveConfigPreview(
  computation: AgentDwsEffectiveConfigComputation,
  binding: OrgAgentChannelBinding,
): AgentDwsConfigPreview {
  const publishedSkillCount = new Set([
    ...computation.publishedAgent.skillIds,
    ...computation.publishedAgent.knowledgeSkillIds,
  ]).size;
  const effective = computation.groupNarrowing;
  const publishedSkills = new Set([
    ...computation.publishedAgent.skillIds,
    ...computation.publishedAgent.knowledgeSkillIds,
  ]);
  const channelTools = new Set(computation.channelCeiling.toolNames);
  const channelSources = new Set(
    computation.channelCeiling.contextSourceIds.filter((sourceId) =>
      computation.publishedAgent.sourceIds.includes(sourceId),
    ),
  );
  const effectiveSkills = intersect(effective.capabilities.skillIds, publishedSkills);
  const effectiveTools = intersect(effective.capabilities.toolNames, channelTools);
  const effectiveSources = effective.knowledge.contextEnabled
    ? intersect(effective.knowledge.sourceIds, channelSources)
    : [];
  const invalidSkills = outside(effective.capabilities.skillIds, publishedSkills);
  const invalidTools = outside(effective.capabilities.toolNames, channelTools);
  const invalidSources = outside(effective.knowledge.sourceIds, channelSources);
  const warnings: AgentDwsConfigPreviewWarning[] = [];
  if (!computation.publishedAgent.enabled)
    warnings.push(warning('agent.unavailable', '当前发布的组织 Agent 未启用'));
  if (computation.publishedAgent.executionMode !== 'dispatcher')
    warnings.push(warning('agent.not_dispatcher', '当前发布值尚未使用任务调度模式'));
  if (effective.knowledge.contextEnabled && !computation.channelCeiling.contextDirectoryAvailable)
    warnings.push(warning('channel.context_unavailable', '渠道暂时无法确认 Context 目录'));
  if (
    !computation.liveOverrides.bindingEnabled ||
    computation.liveOverrides.accountStatus !== 'active'
  )
    warnings.push(warning('conversation.inactive', '当前账号或会话配置尚未激活'));
  if (computation.liveOverrides.liveDeny)
    warnings.push(warning('conversation.live_deny', '当前会话已开启立即阻断'));
  if (invalidSkills.length)
    warnings.push(
      warning(
        'conversation.skills_outside_published',
        '部分已保存技能不在当前发布值内，当前不会生效',
      ),
    );
  if (invalidTools.length)
    warnings.push(
      warning('conversation.tools_outside_channel', '部分已保存工具超出渠道上限，当前不会生效'),
    );
  if (effective.knowledge.contextEnabled && invalidSources.length)
    warnings.push(
      warning(
        'conversation.sources_outside_channel',
        '部分已保存知识源不在当前渠道范围内，当前不会生效',
      ),
    );
  if (effectiveSkills.length < publishedSkillCount)
    warnings.push(info('conversation.skills_narrowed', '会话使用的技能少于当前发布值'));
  if (effectiveTools.length < channelTools.size)
    warnings.push(info('conversation.tools_narrowed', '会话使用的工具少于渠道上限'));
  if (effective.knowledge.contextEnabled && effectiveSources.length < channelSources.size)
    warnings.push(info('conversation.sources_narrowed', '会话使用的知识源少于渠道可用范围'));
  warnings.push(
    info(
      'conversation.full_snapshot',
      '当前会话按完整配置快照生效；预览不表示未填写项会自动恢复继承',
    ),
  );
  const unavailableReasons = [
    ...(!computation.publishedAgent.enabled ? ['组织 Agent 当前未启用'] : []),
    ...(computation.publishedAgent.executionMode !== 'dispatcher'
      ? ['组织 Agent 当前不是任务调度模式']
      : []),
    ...(!computation.liveOverrides.bindingEnabled ? ['会话配置当前未激活'] : []),
    ...(computation.liveOverrides.liveDeny ? ['会话当前已立即阻断'] : []),
    ...(computation.liveOverrides.accountStatus !== 'active' ? ['成员账号当前未启用'] : []),
    ...(effective.knowledge.contextEnabled && !computation.channelCeiling.contextDirectoryAvailable
      ? ['Context 目录当前不可确认']
      : []),
    ...(invalidSkills.length ||
    invalidTools.length ||
    (effective.knowledge.contextEnabled && invalidSources.length)
      ? ['已保存能力超出当前发布值或渠道上限']
      : []),
  ];
  const available = unavailableReasons.length === 0;
  const dwsResourceCount = effectiveTools.includes('DwsBusiness')
    ? (effective.capabilities.dwsResourceIds?.length ?? 0)
    : 0;
  const previewEffective: AgentDwsConfigPreview['effective'] = {
    label: '当前生效范围',
    status: available ? 'available' : 'unavailable',
    unavailableReasons,
    instructionsConfigured: Boolean(effective.instructions?.system?.trim()),
    contextEnabled: effective.knowledge.contextEnabled,
    frontdesk: {
      status: available ? 'available' : 'unavailable',
      skillCount: effectiveSkills.length,
      toolCount: effectiveTools.length,
      sourceCount: effectiveSources.length,
    },
    worker: {
      status: available ? 'task_compile_required' : 'unavailable',
      skillCount: effectiveSkills.length,
      sourceCount: effectiveSources.length,
      dwsResourceCount,
    },
    completion:
      binding.policy.completion === 'silent' ? ('完成后静默' as const) : ('回复原会话' as const),
    taskVisibility:
      binding.policy.taskVisibility === 'requester_only'
        ? ('仅发起人可见' as const)
        : ('群内可见' as const),
  };
  return {
    version: 1,
    layers: [
      {
        source: 'published',
        label: '当前发布值',
        available: computation.publishedAgent.enabled,
        summaries: [
          `可用技能 ${publishedSkillCount} 项`,
          `可用知识源 ${computation.publishedAgent.sourceIds.length} 个`,
          computation.publishedAgent.executionMode === 'dispatcher'
            ? '任务调度模式'
            : '直接响应模式',
        ],
      },
      {
        source: 'channel',
        label: '渠道上限',
        available: computation.channelCeiling.contextDirectoryAvailable,
        summaries: [
          `可用工具 ${computation.channelCeiling.toolNames.length} 项`,
          `可用知识源 ${computation.channelCeiling.contextSourceIds.length} 个`,
        ],
      },
      {
        source: 'conversation',
        label: '会话已保存值',
        available: true,
        summaries: savedSummaries(effective, binding),
      },
    ],
    effective: previewEffective,
    warnings,
  };
}

function savedSummaries(
  saved: OrgAgentChannelBinding['effectiveConfig'],
  binding: OrgAgentChannelBinding,
): string[] {
  return [
    `已保存技能 ${saved.capabilities.skillIds.length} 项，工具 ${saved.capabilities.toolNames.length} 项`,
    saved.knowledge.contextEnabled
      ? `已保存 Context 知识源 ${saved.knowledge.sourceIds.length} 个`
      : '已保存为不启用 Context',
    `完成反馈：${binding.policy.completion === 'silent' ? '完成后静默' : '回复原会话'}`,
  ];
}

function intersect(values: readonly string[], ceiling: ReadonlySet<string>): string[] {
  return [...new Set(values)].filter((value) => ceiling.has(value));
}

function outside(values: readonly string[], ceiling: ReadonlySet<string>): string[] {
  return [...new Set(values)].filter((value) => !ceiling.has(value));
}

function warning(
  code: AgentDwsConfigPreviewWarning['code'],
  message: string,
): AgentDwsConfigPreviewWarning {
  return { code, severity: 'warning', message };
}

function info(
  code: AgentDwsConfigPreviewWarning['code'],
  message: string,
): AgentDwsConfigPreviewWarning {
  return { code, severity: 'info', message };
}
