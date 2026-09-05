import type { ToolCallContext } from '../../agent/toolRuntime.js';
import type { OrgAgentWorkOrder } from '../../data/orgGroupAgents/index.js';
import type { RunRecord } from '../runStore.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import type { OrgAgentWorkOrderControlRequest } from './backgroundTaskRuntime.js';
import { parseBackgroundTaskMetadata } from './backgroundTaskMetadata.js';
import type { OrgAgentBackgroundWorkCoordinator } from './orgAgentBackgroundWork.js';

const ORG_AGENT_BACKGROUND_TASK_POLICY_TOOL = 'BackgroundTask';

export async function controlOrgAgentWorkOrder(
  config: RawRuntimeRunDispatchConfig,
  orgWork: OrgAgentBackgroundWorkCoordinator,
  context: ToolCallContext,
  request: OrgAgentWorkOrderControlRequest,
  task: RunRecord | null,
): Promise<{ task: RunRecord | null; workOrder: OrgAgentWorkOrder }> {
  const metadata = task ? parseBackgroundTaskMetadata(task) : null;
  if (!task || !metadata?.workOrderId || !metadata.orgAgentChannel)
    throw new Error('ORG_AGENT_WORK_ORDER_NOT_FOUND');
  let work = await authorizeOrgAgentWorkOrderMutation(config, context, metadata.workOrderId);
  if (request.action === 'pause') {
    const pausedTask = await orgWork.pause(work.tenantId, work.workOrderId, work.version);
    work = (await config.orgGroupAgentStore!.getWorkOrder(work.tenantId, work.workOrderId))!;
    return { task: pausedTask, workOrder: work };
  }
  if (request.action === 'resume') {
    const resumed = await orgWork.retry(work.tenantId, work.workOrderId, work.version);
    work = (await config.orgGroupAgentStore!.getWorkOrder(work.tenantId, work.workOrderId))!;
    return { task: resumed, workOrder: work };
  }
  if (request.action === 'review' && !['completed', 'failed', 'cancelled'].includes(work.state))
    throw new Error('ORG_AGENT_WORK_ORDER_REVIEW_REQUIRES_TERMINAL');
  const nextControl = {
    ...work.control,
    revision: work.control.revision + 1,
    ...(request.action === 'reassign' ? { workerType: request.workerType! } : {}),
    ...(request.action === 'amend' || request.action === 'review'
      ? {
          supplements: [
            ...work.control.supplements,
            {
              text: request.text!,
              actorOpenId:
                context.channelContext.orgAgentChannel!.externalActor.kind === 'external_user'
                  ? context.channelContext.orgAgentChannel!.externalActor.openId
                  : '',
              createdAt: new Date().toISOString(),
              kind: request.action === 'review' ? ('review' as const) : ('supplement' as const),
            },
          ],
        }
      : {}),
  };
  if (
    (request.action === 'amend' || request.action === 'reassign') &&
    ['queued', 'running', 'waiting_input'].includes(work.state)
  ) {
    await orgWork.pause(work.tenantId, work.workOrderId, work.version);
    work = (await config.orgGroupAgentStore!.getWorkOrder(work.tenantId, work.workOrderId))!;
  }
  const resumed = await orgWork.retry(work.tenantId, work.workOrderId, work.version, {
    allowPendingArtifacts: true,
    control: nextControl,
    supersedePendingCompletion: true,
  });
  work = (await config.orgGroupAgentStore!.getWorkOrder(work.tenantId, work.workOrderId))!;
  return { task: resumed, workOrder: work };
}

export async function authorizeOrgAgentWorkOrderMutation(
  config: RawRuntimeRunDispatchConfig,
  context: ToolCallContext,
  workOrderId: string,
): Promise<OrgAgentWorkOrder> {
  const caller = context.channelContext.orgAgentChannel;
  const store = config.orgGroupAgentStore;
  if (
    !caller ||
    !store ||
    caller.externalActor.kind !== 'external_user' ||
    caller.externalActorAssurance !== 'mapped' ||
    caller.accountId !== caller.agentPrincipal.accountId ||
    caller.agentId !== caller.agentPrincipal.agentId
  )
    throw new Error('ORG_AGENT_WORK_ORDER_MUTATION_DENIED');
  const evaluateChannel = config.orgAgentChannelPolicyEvaluator;
  if (!evaluateChannel) throw new Error('ORG_AGENT_WORK_ORDER_MUTATION_DENIED');
  const livePolicy = await evaluateChannel({
    tenantId: caller.agentPrincipal.tenantId,
    bindingId: caller.bindingId,
    accountId: caller.accountId,
    agentId: caller.agentId,
    conversationId: caller.channelPrincipal.conversationId,
    toolName: ORG_AGENT_BACKGROUND_TASK_POLICY_TOOL,
  });
  if (!livePolicy.allowed) throw new Error('ORG_AGENT_WORK_ORDER_MUTATION_DENIED');
  const [work, binding] = await Promise.all([
    store.getWorkOrder(caller.agentPrincipal.tenantId, workOrderId),
    store.getBindingById(caller.agentPrincipal.tenantId, caller.bindingId),
  ]);
  if (
    !work ||
    work.agentId !== caller.agentId ||
    work.bindingId !== caller.bindingId ||
    work.workConversationId !== caller.workConversationId ||
    !binding ||
    binding.activationState !== 'active' ||
    !binding.enabled ||
    !binding.policy.enabled ||
    binding.policy.liveDeny
  )
    throw new Error('ORG_AGENT_WORK_ORDER_MUTATION_DENIED');
  const creator = work.createdByActor;
  const isCreator =
    creator.provider === caller.externalActor.provider &&
    creator.corpId === caller.externalActor.corpId &&
    creator.openId === caller.externalActor.openId;
  const mayManageOthers =
    caller.actorRole === 'org_admin' &&
    binding.effectiveConfig.access.approvalRoles.includes('org_admin');
  if (!isCreator && !mayManageOthers) throw new Error('ORG_AGENT_WORK_ORDER_MUTATION_DENIED');
  return work;
}
