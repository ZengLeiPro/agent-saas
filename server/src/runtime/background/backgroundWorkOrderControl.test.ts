import { describe, expect, it, vi } from 'vitest';

import { authorizeOrgAgentWorkOrderMutation } from './backgroundWorkOrderControl.js';

const caller = {
  accountId: 'account-1',
  agentId: 'agent-1',
  bindingId: 'binding-1',
  conversationSpaceId: 'space-1',
  workConversationId: 'conversation-1',
  policyRevision: 1,
  agentPrincipal: {
    kind: 'org_agent',
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    accountId: 'account-1',
    workspaceId: 'workspace-1',
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
  approvalRoles: ['member'],
  externalActor: {
    kind: 'external_user',
    provider: 'dingtalk',
    corpId: 'corp-1',
    openId: 'open-1',
    assurance: 'mapped',
    role: 'member',
  },
  channelPrincipal: {
    provider: 'dingtalk',
    accountId: 'account-1',
    conversationId: 'group-1',
    kind: 'group',
  },
} as const;

const context = {
  channelContext: { orgAgentChannel: caller },
} as never;

const work = {
  workOrderId: 'work-1',
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  bindingId: 'binding-1',
  workConversationId: 'conversation-1',
  createdByActor: {
    provider: 'dingtalk',
    corpId: 'corp-1',
    openId: 'open-1',
  },
};

const binding = {
  bindingId: 'binding-1',
  activationState: 'active',
  enabled: true,
  policy: { enabled: true, liveDeny: false },
  effectiveConfig: { access: { approvalRoles: ['member'] } },
};

describe('组织 Agent WorkOrder 实时主体授权', () => {
  it('账号换绑后统一拒绝 amend、pause、resume、review、reassign 与 cancel', async () => {
    const getWorkOrder = vi.fn();
    const getBindingById = vi.fn();
    const evaluate = vi.fn().mockResolvedValue({ allowed: false, reason: 'stale identity' });

    await expect(authorizeOrgAgentWorkOrderMutation({
      orgAgentChannelPolicyEvaluator: evaluate,
      orgGroupAgentStore: { getWorkOrder, getBindingById },
    } as never, context, 'work-1')).rejects.toThrow('ORG_AGENT_WORK_ORDER_MUTATION_DENIED');

    expect(evaluate).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      bindingId: 'binding-1',
      accountId: 'account-1',
      agentId: 'agent-1',
      conversationId: 'group-1',
      toolName: 'BackgroundTask',
    });
    expect(getWorkOrder).not.toHaveBeenCalled();
    expect(getBindingById).not.toHaveBeenCalled();
  });

  it('同一精确身份续授权时允许创建者控制当前 WorkOrder', async () => {
    const evaluate = vi.fn().mockResolvedValue({ allowed: true });

    await expect(authorizeOrgAgentWorkOrderMutation({
      orgAgentChannelPolicyEvaluator: evaluate,
      orgGroupAgentStore: {
        getWorkOrder: vi.fn().mockResolvedValue(work),
        getBindingById: vi.fn().mockResolvedValue(binding),
      },
    } as never, context, 'work-1')).resolves.toEqual(work);
  });
});
