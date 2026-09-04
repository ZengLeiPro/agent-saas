import type { RawRuntimeRunDispatchConfig } from './rawRuntimeRunDispatchTypes.js';
import type { RunRecord } from './runStore.js';
import { appendRunStateChanged } from './runTerminalCoordinator.js';
import type { RuntimeWakeLease } from './runtimeWakeLeaseLifecycle.js';
import type { EventStore, PlatformEvent } from './types.js';
import { authorizeRestoredOrgAgentRequester } from './orgAgentRunContext.js';

export async function authorizeApprovalResumeWake(input: {
  run: RunRecord;
  approvalId: string;
  events: PlatformEvent[];
  eventStore: EventStore;
  eventTenantId: string;
  lease?: RuntimeWakeLease;
  authorizer?: RawRuntimeRunDispatchConfig['authorizeOrgAgentRequesterLive'];
}): Promise<boolean> {
  const hasInteractionResolved = input.events.some(
    (event) =>
      event.type === 'interaction_resolved' &&
      event.sessionId === input.run.sessionId &&
      event.interactionId === input.approvalId,
  );
  const hasApprovalResolved = input.events.some(
    (event) =>
      event.type === 'approval_resolved' &&
      event.sessionId === input.run.sessionId &&
      event.approvalId === input.approvalId,
  );
  if (!hasInteractionResolved || hasApprovalResolved) {
    await input.lease?.release(
      hasApprovalResolved ? 'completed' : 'failed',
      hasApprovalResolved ? 'approval_already_resolved' : 'missing_interaction_resolved_command',
    );
    return false;
  }
  const requesterAccess = await authorizeRestoredOrgAgentRequester(
    input.run.metadata,
    input.authorizer,
  );
  if (requesterAccess.allowed) return true;
  const reason = `org_agent_requester_revoked:${requesterAccess.reason ?? 'denied'}`;
  await input.lease?.release('failed', reason);
  await appendRunStateChanged(
    input.eventStore,
    input.run.sessionId,
    input.run.runId,
    'failed',
    input.run.status,
    reason,
    { tenantId: input.eventTenantId },
  );
  return false;
}
