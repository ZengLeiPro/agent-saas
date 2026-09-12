import { mergeOrgAgentWorkerRuntimePolicy } from '../../data/orgAgents/runtimePolicy.js';
import {
  assertAgentProfileExecutionTarget,
  type BoundAgentRuntimeProfile,
} from '../agentProfiles.js';
import type { RawRuntimeRunDispatchConfig } from '../rawRuntimeRunDispatch.js';
import type { OrgAgentSessionSnapshot, SessionCatalog } from '../sessionCatalog.js';
import type { ExecutionTargetKind } from '../../agent/toolRuntime.js';
import type { BackgroundAgentRequest } from './backgroundTaskRuntime.js';

export async function resolveBackgroundSubagentProfile(input: {
  config: RawRuntimeRunDispatchConfig;
  sessionCatalog: SessionCatalog;
  request: BackgroundAgentRequest;
  tenantId?: string;
  userId?: string;
  executionTarget: ExecutionTargetKind;
  orgAgentSnapshot?: OrgAgentSessionSnapshot;
}): Promise<BoundAgentRuntimeProfile | undefined> {
  if (!input.config.agentRuntimeProfileResolver) return undefined;
  const previousSessionId = input.request.continuation?.previousSessionId;
  const previousSession = previousSessionId
    ? await input.sessionCatalog.get(previousSessionId)
    : null;
  if (
    previousSessionId &&
    (!previousSession ||
      previousSession.deletedAt ||
      previousSession.kind !== 'subagent' ||
      previousSession.tenantId !== input.tenantId ||
      previousSession.userId !== input.userId)
  ) {
    throw new Error('后台子 Agent 的历史 Profile 会话不存在、已删除或身份不一致。');
  }
  let bound = await input.config.agentRuntimeProfileResolver.resolveForSession({
    existingSession: previousSession,
    bindingKey: input.request.agentType === 'explore' ? 'background_explore' : 'background_general',
  });
  if (input.orgAgentSnapshot) {
    bound = {
      ...bound,
      version: {
        ...bound.version,
        config: mergeOrgAgentWorkerRuntimePolicy(
          bound.version.config,
          input.orgAgentSnapshot.runtime,
        ),
      },
    };
  }
  assertAgentProfileExecutionTarget(bound.version.config, input.executionTarget);
  return bound;
}
