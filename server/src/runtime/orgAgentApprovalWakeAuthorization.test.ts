import { describe, expect, it, vi } from 'vitest';

import type { ChannelContext } from '../types/index.js';
import { MemoryEventStore } from '../__tests__/runtimeWake.testHelpers.js';
import { authorizeApprovalResumeWake } from './orgAgentApprovalWakeAuthorization.js';
import { snapshotOrgAgentRunContext } from './orgAgentRunContext.js';
import type { RunRecord } from './runStore.js';

const tenantId = 'tenant-a';

function runRecord(): RunRecord {
  const context: ChannelContext = {
    channel: 'dingtalk',
    user: { id: 'user-a', username: 'alice', role: 'user', tenantId },
    orgAgentChannel: {
      accountId: 'account-a',
      agentId: 'agent-a',
      bindingId: 'binding-a',
      conversationSpaceId: 'space-a',
      workConversationId: 'work-a',
      policyRevision: 1,
      agentPrincipal: {
        kind: 'org_agent',
        tenantId,
        agentId: 'agent-a',
        accountId: 'account-a',
        workspaceId: 'workspace-a',
      },
      externalActorAssurance: 'mapped',
      allowedToolNames: ['DwsBusiness'],
      allowedSkillIds: [],
      allowedSourceIds: [],
      dwsResourceIds: ['doc:doc-a'],
      contextEnabled: false,
      taskVisibility: 'conversation',
      actorRole: 'member',
      triggerRoles: ['member'],
      approvalRoles: ['org_admin'],
      externalActor: {
        kind: 'external_user',
        provider: 'dingtalk',
        corpId: 'corp-a',
        openId: 'open-a',
        mappedUserId: 'user-a',
        role: 'member',
        assurance: 'mapped',
      },
      channelPrincipal: {
        provider: 'dingtalk',
        accountId: 'account-a',
        conversationId: 'group-a',
        kind: 'group',
      },
    },
  };
  const now = new Date().toISOString();
  return {
    runId: 'run-a',
    sessionId: 'session-a',
    userId: 'adws-account-a',
    tenantId,
    status: 'pending',
    channel: 'web',
    requestedAt: now,
    updatedAt: now,
    metadata: snapshotOrgAgentRunContext(context),
  };
}

describe('authorizeApprovalResumeWake', () => {
  it('审批后原请求人已撤权时在恢复 Agent loop 前终结原 Run', async () => {
    const events = new MemoryEventStore();
    await events.append(
      {
        type: 'interaction_resolved',
        sessionId: 'session-a',
        runId: 'run-a',
        interactionId: 'approval-a',
        interactionType: 'approval',
        response: { allow: true },
      },
      { tenantId },
    );
    const release = vi.fn();
    const authorizer = vi.fn().mockResolvedValue({
      allowed: false,
      reason: 'REQUESTER_MEMBERSHIP_CHANGED',
    });

    await expect(
      authorizeApprovalResumeWake({
        run: runRecord(),
        approvalId: 'approval-a',
        events: await events.list(tenantId, 'session-a'),
        eventStore: events,
        eventTenantId: tenantId,
        lease: { runId: 'run-a', renew: vi.fn(), release },
        authorizer,
      }),
    ).resolves.toBe(false);

    expect(authorizer).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(
      'failed',
      'org_agent_requester_revoked:REQUESTER_MEMBERSHIP_CHANGED',
    );
    expect(await events.list(tenantId, 'session-a')).toContainEqual(
      expect.objectContaining({
        type: 'run_state_changed',
        runId: 'run-a',
        status: 'failed',
        reason: 'org_agent_requester_revoked:REQUESTER_MEMBERSHIP_CHANGED',
      }),
    );
  });
});
