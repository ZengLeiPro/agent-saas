import { describe, expect, it, vi } from 'vitest';

import { createSubagentToolPolicy } from './subagentRunner.js';

describe('organization Worker tool policy wiring', () => {
  it('uses the live ChannelBinding evaluator for child Worker calls', async () => {
    const evaluator = vi.fn().mockResolvedValue({ allowed: false, reason: 'live deny' });
    const policy = createSubagentToolPolicy(evaluator);
    const decision = await policy.decide(
      {
        id: 'WriteTool',
        name: 'WriteTool',
        displayName: 'WriteTool',
        description: 'test',
        schema: {} as never,
        risk: 'safe',
        approvalMode: 'never',
        auditCategory: 'test',
      },
      {},
      {
        runId: 'run-a',
        sessionId: 'session-a',
        model: 'model-a',
        cwd: '/task',
        channelContext: {
          channel: 'dingtalk',
          sessionOwner: {
            id: 'adws-account-a',
            username: 'agent-dws:agent-a',
            role: 'user',
            tenantId: 'tenant-a',
          },
          orgAgentChannel: {
            accountId: 'account-a',
            agentId: 'agent-a',
            bindingId: 'binding-a',
            conversationSpaceId: 'space-a',
            workConversationId: 'workconv-a',
            policyRevision: 1,
            agentPrincipal: {
              kind: 'org_agent',
              tenantId: 'tenant-a',
              agentId: 'agent-a',
              accountId: 'account-a',
              workspaceId: 'workspace-a',
            },
            externalActorAssurance: 'mapped',
            allowedToolNames: ['WriteTool'],
            allowedSkillIds: [],
            allowedSourceIds: [],
            dwsResourceIds: [],
            contextEnabled: false,
            taskVisibility: 'conversation',
            actorRole: 'member',
            triggerRoles: [],
            approvalRoles: [],
            externalActor: {
              kind: 'external_user',
              provider: 'dingtalk',
              corpId: 'corp-a',
              openId: 'member-a',
              assurance: 'mapped',
              mappedUserId: 'user-a',
              role: 'member',
            },
            channelPrincipal: {
              provider: 'dingtalk',
              accountId: 'account-a',
              conversationId: 'group-a',
              kind: 'group',
            },
          },
        },
      },
    );

    expect(decision).toEqual({ type: 'deny', reason: 'live deny' });
    expect(evaluator).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        bindingId: 'binding-a',
        toolName: 'WriteTool',
      }),
    );
  });
});
