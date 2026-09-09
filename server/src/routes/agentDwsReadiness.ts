import type {
  AgentDwsReadiness,
  AgentDwsReadinessCheck,
  AgentDwsReadinessCode,
  AgentDwsReadinessFixTarget,
  AgentDwsReadinessSeverity,
} from '@agent/shared/types/agentDwsAccount';

import {
  hasExactAgentDwsProfile,
  type AgentDwsAccountRecord,
} from '../data/agentDwsAccounts/index.js';
import type { OrgAgentChannelBinding } from '../data/orgGroupAgents/index.js';
import { bindingMatchesCurrentAccountIdentity } from '../dws/agentDwsAccountIdentity.js';

const SELF_CONTAINED_WORKER_TOOLS = new Set([
  'WebSearch',
  'WebFetch',
  'Read',
  'Glob',
  'Grep',
  'Artifact',
]);

function check(
  code: AgentDwsReadinessCode,
  severity: AgentDwsReadinessSeverity,
  message: string,
  fixTarget: AgentDwsReadinessFixTarget,
): AgentDwsReadinessCheck {
  return { code, severity, message, fixTarget };
}

function aggregate(checks: AgentDwsReadinessCheck[]): AgentDwsReadiness {
  return {
    status: checks.some((item) => item.severity === 'blocking')
      ? 'blocked'
      : checks.some((item) => item.severity === 'unknown')
        ? 'unknown'
        : 'ready',
    checks,
  };
}

export function deriveAccountDwsReadiness(account: AgentDwsAccountRecord): AgentDwsReadiness {
  const authorized =
    hasExactAgentDwsProfile(account) &&
    account.status !== 'draft' &&
    account.status !== 'authorizing' &&
    account.status !== 'error';
  return aggregate([
    check(
      'account.authorization',
      authorized ? 'ready' : 'blocking',
      authorized ? '成员账号授权有效' : '成员账号尚未完成有效授权',
      'account_authorization',
    ),
    check(
      'stream.ready',
      account.runtimeStatus === 'ready' ? 'ready' : 'blocking',
      account.runtimeStatus === 'ready' ? '消息监听已启动' : '消息监听尚未就绪',
      'stream_runtime',
    ),
    check(
      'stream.lease',
      account.runtimeLeaseActive === undefined
        ? 'unknown'
        : account.runtimeLeaseActive
          ? 'ready'
          : 'blocking',
      account.runtimeLeaseActive === undefined
        ? '暂时无法确认消息监听租约'
        : account.runtimeLeaseActive
          ? '消息监听租约有效'
          : '消息监听租约已失效',
      'stream_runtime',
    ),
  ]);
}

export async function resolveRuntimeV2Readiness(
  probe: ((account: AgentDwsAccountRecord) => boolean | Promise<boolean>) | undefined,
  account: AgentDwsAccountRecord,
): Promise<boolean | undefined> {
  if (!probe) return undefined;
  try {
    return await probe(account);
  } catch {
    return undefined;
  }
}

export function deriveGroupDwsReadiness(input: {
  tenantId: string;
  account: AgentDwsAccountRecord;
  binding: OrgAgentChannelBinding;
  agent?: {
    id: string;
    tenantId: string;
    enabled: boolean;
    allowedSkills?: string[];
    allowedKnowledge?: string[];
    runtime?: { executionMode?: string };
  };
  runtimeV2Ready?: boolean;
  contextCeiling: {
    available: boolean;
    publishedSourceIds: string[];
    channelSourceIds: string[];
  };
  channelToolNames: ReadonlySet<string>;
}): AgentDwsReadiness {
  const { account, binding } = input;
  const agentMatches =
    input.agent?.tenantId === input.tenantId &&
    input.agent.id === binding.agentId &&
    binding.agentId === account.agentId;
  const agentEnabled = agentMatches && input.agent?.enabled === true;
  const dispatcher = agentMatches && input.agent?.runtime?.executionMode === 'dispatcher';
  const bindingActive =
    binding.tenantId === input.tenantId &&
    binding.accountId === account.accountId &&
    binding.agentId === account.agentId &&
    bindingMatchesCurrentAccountIdentity(binding, account) &&
    binding.activationState === 'active' &&
    binding.enabled &&
    binding.policy.enabled;
  const configuredSources = binding.effectiveConfig.knowledge.sourceIds;
  const contextReady =
    !binding.effectiveConfig.knowledge.contextEnabled ||
    (input.contextCeiling.available &&
      configuredSources.length > 0 &&
      configuredSources.every(
        (sourceId) =>
          input.contextCeiling.publishedSourceIds.includes(sourceId) &&
          input.contextCeiling.channelSourceIds.includes(sourceId),
      ));
  const publishedSkills = new Set([
    ...(input.agent?.allowedSkills ?? []),
    ...(input.agent?.allowedKnowledge ?? []),
  ]);
  const capabilities = binding.effectiveConfig.capabilities;
  const dwsResourceIds = capabilities.dwsResourceIds ?? [];
  const hasContextTools =
    capabilities.toolNames.includes('ContextSearch') &&
    capabilities.toolNames.includes('ContextGet');
  const capabilityWithinCeiling =
    capabilities.skillIds.every((skillId) => publishedSkills.has(skillId)) &&
    capabilities.toolNames.every((toolName) => input.channelToolNames.has(toolName)) &&
    (dwsResourceIds.length === 0 || capabilities.toolNames.includes('DwsBusiness')) &&
    (!binding.effectiveConfig.knowledge.contextEnabled || hasContextTools);
  const hasEffectiveCapability =
    capabilities.skillIds.length > 0 ||
    (dwsResourceIds.length > 0 && capabilities.toolNames.includes('DwsBusiness')) ||
    (binding.effectiveConfig.knowledge.contextEnabled && contextReady && hasContextTools) ||
    capabilities.toolNames.some((name) => SELF_CONTAINED_WORKER_TOOLS.has(name));
  const capabilityReady = capabilityWithinCeiling && hasEffectiveCapability;
  const contextSeverity: AgentDwsReadinessSeverity =
    !binding.effectiveConfig.knowledge.contextEnabled || contextReady
      ? 'ready'
      : input.contextCeiling.available
        ? 'blocking'
        : 'unknown';
  return aggregate([
    ...deriveAccountDwsReadiness(account).checks,
    check(
      'agent.enabled',
      agentEnabled ? 'ready' : 'blocking',
      agentEnabled ? '组织 Agent 已启用' : '组织 Agent 不可用或不属于当前组织',
      'agent_settings',
    ),
    check(
      'agent.dispatcher',
      dispatcher ? 'ready' : 'blocking',
      dispatcher ? '组织 Agent 已使用任务调度模式' : '组织 Agent 尚未使用任务调度模式',
      'agent_settings',
    ),
    check(
      'runtime.v2',
      input.runtimeV2Ready === undefined ? 'unknown' : input.runtimeV2Ready ? 'ready' : 'blocking',
      input.runtimeV2Ready === undefined
        ? '暂时无法确认任务运行协议'
        : input.runtimeV2Ready
          ? '任务运行协议已就绪'
          : '任务运行协议尚未就绪',
      'runtime_compatibility',
    ),
    check(
      'binding.active',
      bindingActive ? 'ready' : 'blocking',
      bindingActive ? '当前群配置已激活' : '当前群配置尚未激活',
      'group_binding',
    ),
    check(
      'binding.live_deny',
      binding.policy.liveDeny ? 'blocking' : 'ready',
      binding.policy.liveDeny ? '当前群已开启立即阻断' : '当前群未被立即阻断',
      'group_binding',
    ),
    check(
      'context.dependencies',
      contextSeverity,
      contextSeverity === 'unknown'
        ? '暂时无法确认群知识目录依赖'
        : contextReady
          ? '群知识依赖已就绪'
          : '群知识源未发布或不属于当前账号',
      'context_settings',
    ),
    check(
      'worker.capability',
      capabilityReady ? 'ready' : 'blocking',
      capabilityReady ? '任务执行能力配置有效' : '任务执行能力超出已发布范围或缺少依赖',
      'capability_settings',
    ),
    check(
      'completion.delivery',
      binding.policy.completion === 'reply_to_work_conversation' ? 'ready' : 'blocking',
      binding.policy.completion === 'reply_to_work_conversation'
        ? '任务完成后会回复原会话'
        : '任务完成后不会自动回复',
      'delivery_settings',
    ),
  ]);
}
