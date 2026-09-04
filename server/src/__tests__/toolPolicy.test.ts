import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import type { ToolDescriptor } from '../agent/toolRuntime.js';
import { dwsBusinessToolDescriptor } from '../dws/businessToolProvider.js';
import { DefaultToolPolicy } from '../runtime/toolPolicy.js';
import type { RunContext, ToolPolicyDecision } from '../runtime/types.js';

function descriptor(partial: Partial<ToolDescriptor>): ToolDescriptor {
  return {
    id: partial.id ?? 'TestTool',
    name: partial.name ?? 'TestTool',
    displayName: partial.displayName ?? 'TestTool',
    description: 'test',
    schema: z.object({}),
    risk: partial.risk ?? 'dangerous',
    approvalMode: partial.approvalMode ?? 'web',
    auditCategory: 'test',
    ...partial,
  } as ToolDescriptor;
}

function context(partial: { approvalPolicy?: RunContext['approvalPolicy'] } = {}): RunContext {
  return {
    channelContext: { channel: 'web', user: { id: 'user-1', username: 'alice' } },
    approvalPolicy: partial.approvalPolicy,
  } as unknown as RunContext;
}

describe('DefaultToolPolicy 低风险常开档（TASK-256）', () => {
  const policy = new DefaultToolPolicy();

  async function decide(
    tool: Partial<ToolDescriptor>,
    approvalPolicy: RunContext['approvalPolicy'],
  ): Promise<ToolPolicyDecision> {
    return policy.decide(descriptor(tool), {}, context({ approvalPolicy }));
  }

  it('safe 工具任何档位都放行', async () => {
    expect(await decide({ risk: 'safe' }, undefined)).toEqual({ type: 'allow' });
    expect(await decide({ risk: 'safe' }, { autoApproveTools: true, lowRiskOnly: true })).toEqual({ type: 'allow' });
  });

  it('低风险常开档自动批准 workspace_write，dangerous 仍需人工批准', async () => {
    const lowRisk = { autoApproveTools: true, lowRiskOnly: true } as const;
    expect(await decide({ risk: 'workspace_write' }, lowRisk)).toEqual({ type: 'allow' });
    await expect(decide({ risk: 'dangerous' }, lowRisk)).resolves.toMatchObject({ type: 'requires_approval' });
  });

  it('全部授权档维持既有行为：非 safe 且非 neverAutoApprove 一律放行', async () => {
    expect(await decide({ risk: 'workspace_write' }, { autoApproveTools: true })).toEqual({ type: 'allow' });
    expect(await decide({ risk: 'dangerous' }, { autoApproveTools: true })).toEqual({ type: 'allow' });
  });

  it('未开启自动批准时非 safe 工具一律人工审批（现状回归）', async () => {
    await expect(decide({ risk: 'workspace_write' }, undefined)).resolves.toMatchObject({ type: 'requires_approval' });
    await expect(decide({ risk: 'dangerous' }, undefined)).resolves.toMatchObject({ type: 'requires_approval' });
  });

  it('neverAutoApprove 恒为人工，不受任何自动批准档影响', async () => {
    const neverTool = descriptor({
      risk: 'dangerous',
      resolveCallPolicy: () => ({ risk: 'dangerous', neverAutoApprove: true }),
    });
    await expect(policy.decide(neverTool, {}, context({ approvalPolicy: { autoApproveTools: true } })))
      .resolves.toMatchObject({ type: 'requires_approval' });
    await expect(policy.decide(neverTool, {}, context({ approvalPolicy: { autoApproveTools: true, lowRiskOnly: true } })))
      .resolves.toMatchObject({ type: 'requires_approval' });
  });

  it('resolveCallPolicy 动态降档：dangerous 工具的 safe 调用在低风险档也放行', async () => {
    const dynamicTool = descriptor({
      risk: 'dangerous',
      resolveCallPolicy: () => ({ risk: 'safe' }),
    });
    expect(await policy.decide(dynamicTool, {}, context({ approvalPolicy: { autoApproveTools: true, lowRiskOnly: true } })))
      .toEqual({ type: 'allow' });
    expect(await policy.decide(dynamicTool, {}, context({ approvalPolicy: undefined })))
      .toEqual({ type: 'allow' });
  });
});

describe('DefaultToolPolicy 组织 Agent 群聊门禁', () => {
  const livePolicy = async () => ({ allowed: true });
  const channelContext = {
    channel: 'dingtalk',
    sessionOwner: { id: 'service-user', username: 'service', tenantId: 'tenant-1' },
    orgAgentChannel: {
      bindingId: 'binding-1', accountId: 'account-1', agentId: 'agent-1',
      channelPrincipal: { provider: 'dingtalk', accountId: 'account-1', conversationId: 'group-1', kind: 'group' },
      allowedToolNames: ['WriteTool'], approvalRoles: ['org_admin'], actorRole: 'member',
    },
  } as unknown as RunContext['channelContext'];

  it('denies write tools when the current actor role is outside approvalRoles', async () => {
    const policy = new DefaultToolPolicy(livePolicy);
    const result = await policy.decide(descriptor({ id: 'WriteTool', name: 'WriteTool', risk: 'workspace_write' }), {}, {
      channelContext,
      approvalPolicy: { autoApproveTools: true },
    } as RunContext);
    expect(result).toEqual({ type: 'deny', reason: 'actor role cannot approve this ChannelBinding capability' });
  });

  it('still allows a safe tool for the same actor role', async () => {
    const policy = new DefaultToolPolicy(livePolicy);
    const result = await policy.decide(descriptor({ id: 'WriteTool', name: 'WriteTool', risk: 'safe' }), {}, {
      channelContext,
    } as RunContext);
    expect(result).toEqual({ type: 'allow' });
  });

  it('DwsBusiness 使用群动作矩阵确定性放行共享读与已确认低风险写', async () => {
    const dwsChannel = {
      channel: 'dingtalk',
      user: { id: 'user-1', username: 'alice', tenantId: 'tenant-1' },
      sessionOwner: { id: 'adws-account-1', username: 'agent-dws:agent-1', tenantId: 'tenant-1' },
      orgAgentChannel: {
        bindingId: 'binding-1', accountId: 'account-1', agentId: 'agent-1',
        conversationSpaceId: 'space-1', workConversationId: 'work-1', policyRevision: 1,
        agentPrincipal: { kind: 'org_agent', tenantId: 'tenant-1', agentId: 'agent-1',
          accountId: 'account-1', workspaceId: 'workspace-1' },
        externalActorAssurance: 'mapped', allowedToolNames: ['DwsBusiness'],
        allowedSkillIds: [], allowedSourceIds: [], dwsResourceIds: ['doc:doc-1'], contextEnabled: false,
        taskVisibility: 'conversation', actorRole: 'member', triggerRoles: [], approvalRoles: ['member'],
        externalActor: { kind: 'external_user', provider: 'dingtalk', corpId: 'corp-1', openId: 'open-1',
          mappedUserId: 'user-1', role: 'member', assurance: 'mapped' },
        channelPrincipal: { provider: 'dingtalk', accountId: 'account-1',
          conversationId: 'group-1', kind: 'group' },
      },
    } as unknown as RunContext['channelContext'];
    const policy = new DefaultToolPolicy(livePolicy);
    await expect(policy.decide(dwsBusinessToolDescriptor, {
      args: ['doc', 'read', '--node', 'doc-1'], credentialMode: 'agent',
    }, { channelContext: dwsChannel } as RunContext)).resolves.toEqual({ type: 'allow' });
    await expect(policy.decide(dwsBusinessToolDescriptor, {
      args: ['doc', 'update', '--node', 'doc-1', '--content', '正文'],
      credentialMode: 'agent', confirmed: true,
    }, { channelContext: dwsChannel } as RunContext)).resolves.toEqual({ type: 'allow' });

    await expect(policy.decide(dwsBusinessToolDescriptor, {
      args: ['doc', 'read', '--node', 'doc-1'], credentialMode: 'requester',
    }, { channelContext: dwsChannel } as RunContext)).resolves.toMatchObject({ type: 'deny' });
    await expect(policy.decide(dwsBusinessToolDescriptor, {
      args: ['todo', 'task', 'list'], credentialMode: 'agent',
    }, { channelContext: dwsChannel } as RunContext)).resolves.toMatchObject({ type: 'deny' });
    await expect(policy.decide(dwsBusinessToolDescriptor, {
      args: ['doc', 'read', '--node', 'doc-1'], credentialMode: 'agent',
    }, { channelContext: dwsChannel, executionRole: 'worker' } as RunContext))
      .resolves.toMatchObject({ type: 'deny' });
  });
});
