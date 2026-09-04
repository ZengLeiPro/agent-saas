import type { OrgAgentChannelBinding, OrgAgentWorkOrder } from '../data/orgGroupAgents/index.js';
import type { SharedGroupContext } from './orgAgentSharedGroupContext.js';

export function formatPrivateCompletion(work: OrgAgentWorkOrder): string {
  const state =
    work.state === 'completed' ? '已完成' : work.state === 'cancelled' ? '已取消' : '执行失败';
  const summary = work.resultEnvelope?.summary?.trim();
  return `任务「${work.title.slice(0, 200)}」${state}${summary ? `：${summary.slice(0, 4_000)}` : '。'}`;
}

export function sharedAllowedTools(shared: SharedGroupContext): string[] {
  const contextTools = new Set(['ContextSearch', 'ContextGet']);
  const sharedReadTools = new Set(['DwsBusiness', ...contextTools]);
  const alwaysPersonal = new Set(['MemoryCommand', 'UserActivityList']);
  if (shared.externalActor.kind === 'service_event') return [];
  if (shared.externalActor.assurance !== 'mapped') {
    return allowsGuestSharedRead(shared.binding)
      ? shared.binding.effectiveConfig.capabilities.toolNames.filter(
          (name) =>
            sharedReadTools.has(name) &&
            (name === 'DwsBusiness' || shared.binding.effectiveConfig.knowledge.contextEnabled),
        )
      : [];
  }
  return shared.binding.effectiveConfig.capabilities.toolNames.filter(
    (name) =>
      !alwaysPersonal.has(name) &&
      (shared.binding.effectiveConfig.knowledge.contextEnabled || !contextTools.has(name)),
  );
}

export function allowsGuestSharedRead(binding: OrgAgentChannelBinding): boolean {
  return (
    binding.policy.membership === 'members_and_guests' &&
    binding.policy.guest === 'shared_read_only'
  );
}
