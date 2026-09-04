import { describe, expect, it } from 'vitest';

import type { ChannelContext } from '../types/index.js';
import { restoreOrgAgentRunContext, snapshotOrgAgentRunContext } from './orgAgentRunContext.js';

function context(): ChannelContext {
  return {
    channel: 'dingtalk',
    user: { id: 'user-a', username: 'alice', role: 'user', tenantId: 'tenant-a' },
    orgAgentChannel: {
      accountId: 'account-a',
      agentId: 'agent-a',
      bindingId: 'binding-a',
      conversationSpaceId: 'space-a',
      workConversationId: 'conversation-a',
      policyRevision: 2,
      agentPrincipal: {
        kind: 'org_agent',
        tenantId: 'tenant-a',
        agentId: 'agent-a',
        accountId: 'account-a',
        workspaceId: 'workspace-a',
      },
      externalActorAssurance: 'mapped',
      allowedToolNames: [],
      allowedSkillIds: [],
      allowedSourceIds: [],
      dwsResourceIds: [],
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
}

describe('orgAgentRunContext', () => {
  it('只在原请求人与 durable externalActor 完全一致时恢复身份', () => {
    const snapshot = snapshotOrgAgentRunContext(context());
    expect(restoreOrgAgentRunContext(snapshot)).toMatchObject({
      user: { id: 'user-a', tenantId: 'tenant-a' },
      orgAgentChannel: { bindingId: 'binding-a', workConversationId: 'conversation-a' },
    });
    expect(
      restoreOrgAgentRunContext({
        ...snapshot,
        orgAgentRequester: {
          id: 'attacker',
          username: 'mallory',
          role: 'admin',
          tenantId: 'tenant-a',
        },
      }),
    ).toEqual({ orgAgentChannel: snapshot.orgAgentChannel });
  });
});
