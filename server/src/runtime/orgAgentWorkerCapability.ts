import type { ToolDescriptor } from '../agent/toolRuntime.js';
import type { RunContext } from './types.js';
import type { RuntimeIsolationRequirement } from './runtimeIsolationEvidence.js';
import { RUNTIME_ISOLATION_POLICY_DIGEST } from './runtimeIsolationEvidence.js';
import type { OrgAgentWorkerTaskLineage } from './orgAgentTaskWorkspace.js';

export interface OrgAgentWorkerTaskAuthority {
  readonly taskRunId: string; readonly taskSessionId: string; readonly attemptId: string;
  assertCurrent(toolName?: string): Promise<void>;
}

export interface OrgAgentWorkerRunContext {
  /** 当前 run 与隔离 hand 证据绑定的可信要求。 */
  runtimeIsolationRequirement?: RuntimeIsolationRequirement;
  /** 仅 Runtime 在组织任务的隔离 hand 完成证据校验后写入。 */
  runtimeIsolationAttested?: boolean;
  /** 当前短命执行单元的组织角色；不能由渠道请求直接指定。 */
  executionRole?: 'worker';
  orgAgentTaskLineage?: OrgAgentWorkerTaskLineage;
  orgAgentTaskAuthority?: OrgAgentWorkerTaskAuthority;
}

interface OrgAgentWorkerAuthorizationContext extends OrgAgentWorkerRunContext {
  runId?: string; sessionId?: string; workspaceId?: string; sandboxScopeId?: string;
  runtimeIsolationRequirement?: RuntimeIsolationRequirement; channelContext: RunContext['channelContext'];
}

/**
 * 前台只负责接单；通过 task isolation attestation 的 Worker 才能获得任务目录写能力。
 * Artifact 的模型协议名也列在这里，兼容内部 CreateArtifact transport 协议。
 */
export const ORG_AGENT_WORKER_TASK_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'Shell',
  'Artifact',
  'CreateArtifact',
]);

export function isAttestedOrgAgentWorkerTaskContext(context: OrgAgentWorkerAuthorizationContext): context is OrgAgentWorkerAuthorizationContext & { orgAgentTaskLineage: OrgAgentWorkerTaskLineage } {
  const channel = context.channelContext.orgAgentChannel, requirement = context.runtimeIsolationRequirement;
  const lineage = context.orgAgentTaskLineage, authority = context.orgAgentTaskAuthority;
  const tenantId = context.channelContext.sessionOwner?.tenantId ?? context.channelContext.user?.tenantId;
  if (!channel || !requirement || !lineage || !authority || context.executionRole !== 'worker'
    || context.runtimeIsolationAttested !== true || !context.runId || !context.sessionId
    || !context.workspaceId || !context.sandboxScopeId) return false;
  return lineage.kind === 'org_agent_task' && lineage.attemptNo === lineage.currentAttemptNo
    && lineage.taskRunId === authority.taskRunId && lineage.taskSessionId === authority.taskSessionId
    && lineage.attemptId === authority.attemptId && lineage.tenantId === tenantId
    && lineage.tenantId === channel.agentPrincipal.tenantId && lineage.agentId === channel.agentId
    && lineage.agentId === channel.agentPrincipal.agentId && lineage.accountId === channel.accountId
    && lineage.accountId === channel.agentPrincipal.accountId
    && lineage.ownerWorkspaceId === channel.agentPrincipal.workspaceId
    && lineage.bindingId === channel.bindingId && lineage.conversationSpaceId === channel.conversationSpaceId
    && lineage.workConversationId === channel.workConversationId
    && lineage.channelConversationId === channel.channelPrincipal.conversationId
    && lineage.policyRevision === channel.policyRevision
    && sameStringSet(lineage.allowedSourceIds, channel.allowedSourceIds)
    && lineage.workOrderId === requirement.taskId && lineage.taskWorkspaceId === context.workspaceId
    && lineage.taskWorkspaceId === requirement.workspaceId && lineage.sandboxScopeId === context.sandboxScopeId
    && requirement.tenantId === lineage.tenantId && requirement.runId === context.runId
    && requirement.sessionId === context.sessionId
    && requirement.policyDigest === RUNTIME_ISOLATION_POLICY_DIGEST;
}

export async function assertLiveOrgAgentWorkerTaskAuthority(
  context: OrgAgentWorkerAuthorizationContext,
  toolName?: string,
): Promise<void> {
  const authority = context.orgAgentTaskAuthority;
  if (!authority || !isAttestedOrgAgentWorkerTaskContext(context))
    throw new Error('ORG_AGENT_WORKER_TASK_AUTHORITY_INVALID');
  await authority.assertCurrent(toolName);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length
    && new Set(right).size === right.length && left.every(value => right.includes(value));
}

export function isAttestedOrgAgentWorkerTaskTool(
  descriptor: Pick<ToolDescriptor, 'id' | 'name'>,
  context: RunContext,
): boolean {
  if (
    !ORG_AGENT_WORKER_TASK_TOOL_NAMES.has(descriptor.id) &&
    !ORG_AGENT_WORKER_TASK_TOOL_NAMES.has(descriptor.name)
  )
    return false;
  return Boolean(
    isAttestedOrgAgentWorkerTaskContext(context) &&
    context.executionTarget === 'server-remote' &&
    context.sandboxScopeId,
  );
}
