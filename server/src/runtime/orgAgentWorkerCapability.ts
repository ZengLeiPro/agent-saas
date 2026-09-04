import type { ToolDescriptor } from '../agent/toolRuntime.js';
import type { RunContext } from './types.js';
import type { RuntimeIsolationRequirement } from './runtimeIsolationEvidence.js';

export interface OrgAgentWorkerRunContext {
  /** 当前 run 与隔离 hand 证据绑定的可信要求。 */
  runtimeIsolationRequirement?: RuntimeIsolationRequirement;
  /** 仅 Runtime 在组织任务的隔离 hand 完成证据校验后写入。 */
  runtimeIsolationAttested?: boolean;
  /** 当前短命执行单元的组织角色；不能由渠道请求直接指定。 */
  executionRole?: 'worker';
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

export function isAttestedOrgAgentWorkerTaskTool(
  descriptor: Pick<ToolDescriptor, 'id' | 'name'>,
  context: RunContext,
): boolean {
  if (
    !ORG_AGENT_WORKER_TASK_TOOL_NAMES.has(descriptor.id) &&
    !ORG_AGENT_WORKER_TASK_TOOL_NAMES.has(descriptor.name)
  )
    return false;
  const channel = context.channelContext.orgAgentChannel;
  const requirement = context.runtimeIsolationRequirement;
  const tenantId =
    context.channelContext.sessionOwner?.tenantId ?? context.channelContext.user?.tenantId;
  return Boolean(
    channel &&
    context.executionRole === 'worker' &&
    context.runtimeIsolationAttested === true &&
    context.executionTarget === 'server-remote' &&
    context.sandboxScopeId &&
    requirement &&
    requirement.tenantId === tenantId &&
    requirement.tenantId === channel.agentPrincipal.tenantId &&
    requirement.runId === context.runId &&
    requirement.sessionId === context.sessionId &&
    requirement.workspaceId === context.workspaceId &&
    requirement.policyDigest.length > 0,
  );
}
