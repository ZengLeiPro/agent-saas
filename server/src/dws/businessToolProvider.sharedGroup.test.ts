import { describe, expect, it, vi } from 'vitest';

import type { ToolCallContext } from '../agent/toolRuntime.js';
import { InMemoryGovernanceAuditStore } from '../data/governance-audit/store.js';
import { DwsBusinessToolProvider } from './businessToolProvider.js';

const account = {
  accountId: 'account-a',
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  displayName: '专家甲',
  loginId: 'login-a',
  profileId: 'agent-corp:agent-user',
  corpId: 'agent-corp',
  dingtalkUserId: 'agent-user',
  status: 'active',
  runtimeStatus: 'ready',
  eventKinds: ['at_me', 'all_direct'],
  revision: 1,
  createdAt: '2026-08-25T00:00:00.000Z',
  createdBy: 'admin-a',
  updatedAt: '2026-08-25T00:00:00.000Z',
  updatedBy: 'admin-a',
} as const;

const user = {
  id: 'user-a',
  username: 'alice',
  role: 'user' as const,
  tenantId: 'tenant-a',
  dingtalkStaffId: 'sender-a',
  disabled: false,
};

const serviceUser = {
  id: 'adws-account-a',
  username: 'agent-dws:agent-a',
  role: 'user' as const,
  tenantId: 'tenant-a',
  disabled: false,
};

const sharedPrincipal = {
  kind: 'org_agent' as const,
  tenantId: 'tenant-a',
  agentId: 'agent-a',
  accountId: 'account-a',
  workspaceId: 'org-agent-workspace-a',
};

type SharedGroupInput = {
  assurance: 'mapped' | 'unmapped';
  actorRole?: 'member' | 'org_admin';
  approvalRoles?: Array<'member' | 'org_admin'>;
  dwsResourceIds?: string[];
  bindingRevision?: number;
  sessionExecutionRole?: 'dispatcher' | 'worker';
};

function setup(sharedGroup: SharedGroupInput) {
  const auditStore = new InMemoryGovernanceAuditStore();
  const invoke = vi.fn().mockResolvedValue({
    status: 'success',
    content: '{"ok":true}',
    metadata: { exitCode: 0, command: 'dws --profile agent-corp:agent-user' },
  });
  const listEffectiveResourceIds = vi.fn().mockImplementation(
    async (_tenantId: string, _userId: string, resourceType: string) => (
      resourceType === 'org_agent' ? [{ resourceId: 'agent-a' }] : []
    ),
  );
  const getMembership = vi.fn().mockResolvedValue({
    tenantId: 'tenant-a', userId: 'user-a', persona: sharedGroup.actorRole ?? 'member',
    isOwner: false, status: 'active', source: 'governance', version: 1,
    createdAt: '2026-09-04T00:00:00.000Z', createdBy: 'admin-a',
    updatedAt: '2026-09-04T00:00:00.000Z', updatedBy: 'admin-a',
  });
  const sharedBinding = {
    bindingId: 'binding-a',
    tenantId: 'tenant-a',
    accountId: 'account-a',
    agentId: 'agent-a',
    conversationId: 'group-a',
    channelKind: 'group',
    activationState: 'active',
    enabled: true,
    conversationSpaceId: 'space-a',
    serviceSessionId: 'session-a',
    workspaceId: 'org-agent-workspace-a',
    policy: {
      enabled: true,
      membership: 'members_and_guests',
      guest: 'shared_read_only',
      taskVisibility: 'conversation',
      completion: 'reply_to_work_conversation',
      liveDeny: false,
    },
    effectiveConfig: {
      identity: {},
      knowledge: { contextEnabled: false, sourceIds: [] },
      capabilities: {
        skillIds: [],
        toolNames: ['DwsBusiness'],
        dwsResourceIds: sharedGroup.dwsResourceIds ?? ['doc:doc-a'],
      },
      access: { triggerRoles: [], approvalRoles: sharedGroup.approvalRoles ?? [] },
      speech: { proactive: false, requireMention: true },
    },
    revision: sharedGroup.bindingRevision ?? 7,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z',
  } as const;
  const provider = new DwsBusinessToolProvider({
    agentCwd: '/workspace',
    accountStore: { listForTenant: vi.fn().mockResolvedValue([account]) } as never,
    assignmentStore: { listEffectiveResourceIds } as never,
    membershipStore: { getMembership } as never,
    orgAgentStore: { get: vi.fn().mockReturnValue({
      id: 'agent-a', tenantId: 'tenant-a', enabled: true,
      audience: { exposure: 'all', usernames: [] },
    }) } as never,
    orgGroupAgentStore: { getBindingById: vi.fn().mockResolvedValue(sharedBinding) } as never,
    connectionStore: { listForUser: vi.fn().mockResolvedValue([]) } as never,
    userStore: { findById: vi.fn().mockReturnValue(user) } as never,
    sessionCatalog: {
      get: vi.fn().mockResolvedValue({
        sessionId: 'session-a',
        userId: serviceUser.id,
        username: serviceUser.username,
        userRole: 'user',
        tenantId: 'tenant-a',
        channel: 'dingtalk',
        cwd: '/workspace/agent',
        transcriptPath: 'x',
        orgAgentId: 'agent-a',
        principal: sharedPrincipal,
        executionRole: sharedGroup.sessionExecutionRole ?? 'dispatcher',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      }),
    },
    auditStore,
    resolveServerRemote: vi.fn().mockResolvedValue({
      baseUrl: 'https://hand.test',
      authToken: 'remote-token',
    }),
    createTransport: () => ({ invoke }),
    logger: { warn: vi.fn() },
  });
  const executionAudit = { records: [], record: vi.fn() };
  const context: ToolCallContext = {
    channelContext: {
      channel: 'dingtalk',
      sessionOwner: serviceUser,
      ...(sharedGroup.assurance === 'mapped' ? { user } : {}),
      orgAgentChannel: {
        bindingId: 'binding-a',
        accountId: 'account-a',
        agentId: 'agent-a',
        conversationSpaceId: 'space-a',
        workConversationId: 'work-conversation-a',
        policyRevision: sharedGroup.bindingRevision ?? 7,
        agentPrincipal: sharedPrincipal,
        externalActorAssurance: sharedGroup.assurance,
        allowedToolNames: ['DwsBusiness'],
        allowedSkillIds: [],
        allowedSourceIds: [],
        dwsResourceIds: sharedGroup.dwsResourceIds ?? ['doc:doc-a'],
        contextEnabled: false,
        taskVisibility: 'conversation',
        ...(sharedGroup.actorRole ? { actorRole: sharedGroup.actorRole } : {}),
        triggerRoles: [],
        approvalRoles: sharedGroup.approvalRoles ?? [],
        externalActor:
          sharedGroup.assurance === 'mapped'
            ? {
                kind: 'external_user',
                provider: 'dingtalk',
                corpId: 'agent-corp',
                openId: 'sender-a',
                mappedUserId: 'user-a',
                role: sharedGroup.actorRole ?? 'member',
                assurance: 'mapped',
              }
            : {
                kind: 'external_user',
                provider: 'dingtalk',
                corpId: 'agent-corp',
                openId: 'guest-a',
                assurance: 'unmapped',
              },
        channelPrincipal: {
          provider: 'dingtalk',
          accountId: 'account-a',
          conversationId: 'group-a',
          kind: 'group',
        },
      },
    },
    workspace: {
      id: 'org-agent-workspace-a',
      root: '/workspace/agent',
      userId: serviceUser.id,
      username: serviceUser.username,
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      executionTarget: 'server-remote',
    },
    sessionId: 'session-a',
    runId: 'run-a',
    toolCallId: 'tool-a',
    invocationId: 'invocation-a',
    executionAudit,
  };
  return { provider, invoke, context, listEffectiveResourceIds, getMembership };
}

describe('DwsBusinessToolProvider 组织群动作矩阵', () => {
  it('mapped 与未映射访客都只可读取当前 binding 显式登记的资源', async () => {
    for (const assurance of ['mapped', 'unmapped'] as const) {
      const test = setup({
        assurance,
        ...(assurance === 'mapped' ? { actorRole: 'member' as const } : {}),
        approvalRoles: ['member'],
      });
      await expect(
        test.provider.invoke(
          {
            toolId: 'DwsBusiness',
            input: { args: ['doc', 'read', '--node', 'doc-a'], credentialMode: 'agent' },
            authorization: { approved: true, source: 'policy_auto' },
          },
          test.context,
        ),
      ).resolves.toMatchObject({ content: '{"ok":true}' });
      expect(test.invoke).toHaveBeenCalledOnce();
      expect(test.listEffectiveResourceIds).toHaveBeenCalledTimes(
        assurance === 'mapped' ? 1 : 0,
      );
      expect(test.invoke.mock.calls[0]![0].context.workspace).toMatchObject({
        userId: 'account-a',
        tenantId: 'tenant-a',
        executionTarget: 'server-remote',
      });
    }
  });

  it('其他群资源、没有资源目标与没有 scope 都 fail closed', async () => {
    const otherResource = setup({ assurance: 'mapped', actorRole: 'member' });
    await expect(
      otherResource.provider.invoke(
        {
          toolId: 'DwsBusiness',
          input: { args: ['doc', 'read', '--node', 'doc-b'], credentialMode: 'agent' },
          authorization: { approved: true, source: 'policy_auto' },
        },
        otherResource.context,
      ),
    ).rejects.toThrow('DWS resource is not allowlisted for the current group binding');
    expect(otherResource.invoke).not.toHaveBeenCalled();

    const secondaryResource = setup({
      assurance: 'mapped',
      actorRole: 'member',
      approvalRoles: ['member'],
    });
    await expect(
      secondaryResource.provider.invoke(
        {
          toolId: 'DwsBusiness',
          input: {
            args: ['doc', 'copy', '--node', 'doc-a', '--folder', 'folder-b'],
            credentialMode: 'agent',
            confirmed: true,
          },
          authorization: { approved: true, source: 'policy_auto' },
        },
        secondaryResource.context,
      ),
    ).rejects.toThrow('DWS resource is not allowlisted for the current group binding');
    expect(secondaryResource.invoke).not.toHaveBeenCalled();

    const undeclaredSecondSelector = setup({ assurance: 'unmapped' });
    await expect(
      undeclaredSecondSelector.provider.invoke(
        {
          toolId: 'DwsBusiness',
          input: {
            args: ['doc', 'read', '--node', 'doc-a', '--folder', 'folder-b'],
            credentialMode: 'agent',
          },
          authorization: { approved: true, source: 'policy_auto' },
        },
        undeclaredSecondSelector.context,
      ),
    ).rejects.toThrow('no deterministic shared-group resource target');
    expect(undeclaredSecondSelector.invoke).not.toHaveBeenCalled();

    const missingTarget = setup({ assurance: 'unmapped' });
    await expect(
      missingTarget.provider.invoke(
        {
          toolId: 'DwsBusiness',
          input: { args: ['doc', 'search', '--query', '季度经营'], credentialMode: 'agent' },
          authorization: { approved: true, source: 'policy_auto' },
        },
        missingTarget.context,
      ),
    ).rejects.toThrow('no deterministic shared-group resource target');
    expect(missingTarget.invoke).not.toHaveBeenCalled();

    const missingScope = setup({ assurance: 'mapped', actorRole: 'member', dwsResourceIds: [] });
    await expect(
      missingScope.provider.invoke(
        {
          toolId: 'DwsBusiness',
          input: { args: ['doc', 'read', '--node', 'doc-a'], credentialMode: 'agent' },
          authorization: { approved: true, source: 'policy_auto' },
        },
        missingScope.context,
      ),
    ).rejects.toThrow('DWS resource is not allowlisted for the current group binding');
    expect(missingScope.invoke).not.toHaveBeenCalled();
  });

  it('低风险写只允许 mapped、配置组织管理员审批且持有平台人工审批', async () => {
    const allowed = setup({ assurance: 'mapped', actorRole: 'member', approvalRoles: ['org_admin'] });
    await expect(
      allowed.provider.invoke(
        {
          toolId: 'DwsBusiness',
          input: {
            args: ['doc', 'update', '--node', 'doc-a', '--content', '正文', '--mode', 'append'],
            credentialMode: 'agent',
            confirmed: true,
          },
          authorization: { approved: true, source: 'policy_auto' },
        },
        allowed.context,
      ),
    ).rejects.toThrow('缺少平台持久化人工审批');
    expect(allowed.invoke).not.toHaveBeenCalled();

    await expect(
      allowed.provider.invoke(
        {
          toolId: 'DwsBusiness',
          input: {
            args: ['doc', 'update', '--node', 'doc-a', '--content', '正文', '--mode', 'append'],
            credentialMode: 'agent',
            confirmed: true,
          },
          authorization: { approved: true, source: 'human_approval', approvalId: 'approval-a' },
        },
        allowed.context,
      ),
    ).resolves.toMatchObject({ content: '{"ok":true}' });
    expect(allowed.invoke.mock.calls[0]![0].input.command).toContain("'--yes'");

    for (const test of [
      setup({ assurance: 'unmapped', approvalRoles: ['org_admin'] }),
      setup({ assurance: 'mapped', actorRole: 'member', approvalRoles: ['member'] }),
    ]) {
      await expect(
        test.provider.invoke(
          {
            toolId: 'DwsBusiness',
            input: {
              args: ['doc', 'update', '--node', 'doc-a', '--content', '正文', '--mode', 'append'],
              credentialMode: 'agent',
              confirmed: true,
            },
            authorization: { approved: true, source: 'policy_auto' },
          },
          test.context,
        ),
      ).rejects.toThrow('当前共享群不允许此 DWS 操作');
      expect(test.invoke).not.toHaveBeenCalled();
    }
  });

  it('对 requester、个人数据、代办、未知、高影响命令及 Worker fail closed', async () => {
    const cases = [
      { args: ['doc', 'read', '--node', 'doc-a'], credentialMode: 'requester' },
      { args: ['mail', 'message', 'list'], credentialMode: 'agent' },
      { args: ['calendar', 'event', 'list'], credentialMode: 'agent' },
      { args: ['todo', 'task', 'list'], credentialMode: 'agent' },
      { args: ['doc', 'future-action'], credentialMode: 'agent' },
      { args: ['doc', 'delete'], credentialMode: 'agent', confirmed: true },
    ];
    for (const input of cases) {
      const test = setup({ assurance: 'mapped', actorRole: 'member', approvalRoles: ['member'] });
      await expect(
        test.provider.invoke(
          {
            toolId: 'DwsBusiness',
            input,
            authorization: { approved: true, source: 'policy_auto' },
          },
          test.context,
        ),
      ).rejects.toThrow();
      expect(test.invoke).not.toHaveBeenCalled();
    }
    const worker = setup({
      assurance: 'mapped',
      actorRole: 'member',
      approvalRoles: ['member'],
      sessionExecutionRole: 'worker',
    });
    await expect(
      worker.provider.invoke(
        {
          toolId: 'DwsBusiness',
          input: { args: ['doc', 'read', '--node', 'doc-a'], credentialMode: 'agent' },
          authorization: { approved: true, source: 'policy_auto' },
        },
        worker.context,
      ),
    ).rejects.toThrow('organization Worker cannot use DwsBusiness');
    expect(worker.invoke).not.toHaveBeenCalled();
  });

  it('按 service-owned session 校验 workspace/principal，不会因 operator 与 owner 不同误拒', async () => {
    const test = setup({ assurance: 'mapped', actorRole: 'member', approvalRoles: ['member'] });
    expect(test.context.channelContext.user?.id).toBe('user-a');
    expect(test.context.channelContext.sessionOwner?.id).toBe('adws-account-a');
    await expect(
      test.provider.invoke(
        {
          toolId: 'DwsBusiness',
          input: { args: ['doc', 'read', '--node', 'doc-a'], credentialMode: 'agent' },
          authorization: { approved: true, source: 'policy_auto' },
        },
        test.context,
      ),
    ).resolves.toMatchObject({ content: '{"ok":true}' });

    await expect(
      test.provider.invoke(
        {
          toolId: 'DwsBusiness',
          input: { args: ['doc', 'read', '--node', 'doc-a'], credentialMode: 'agent' },
          authorization: { approved: true, source: 'policy_auto' },
        },
        { ...test.context, workspace: { ...test.context.workspace, id: 'wrong-workspace' } },
      ),
    ).rejects.toThrow('workspace.id');
  });

  it('审批后执行前重新校验原请求人的实时成员资格和 Agent Assignment', async () => {
    const revokedMember = setup({
      assurance: 'mapped', actorRole: 'member', approvalRoles: ['org_admin'],
    });
    revokedMember.getMembership.mockResolvedValueOnce({
      tenantId: 'tenant-a', userId: 'user-a', persona: 'member', isOwner: false,
      status: 'disabled', source: 'governance', version: 2,
      createdAt: '2026-09-04T00:00:00.000Z', createdBy: 'admin-a',
      updatedAt: '2026-09-04T01:00:00.000Z', updatedBy: 'admin-a',
    });
    await expect(revokedMember.provider.invoke({
      toolId: 'DwsBusiness',
      input: {
        args: ['doc', 'update', '--node', 'doc-a', '--content', '正文'],
        credentialMode: 'agent', confirmed: true,
      },
      authorization: { approved: true, source: 'human_approval', approvalId: 'approval-a' },
    }, revokedMember.context)).rejects.toThrow('原请求者当前已无权');
    expect(revokedMember.invoke).not.toHaveBeenCalled();

    const revokedAssignment = setup({
      assurance: 'mapped', actorRole: 'member', approvalRoles: ['org_admin'],
    });
    revokedAssignment.listEffectiveResourceIds.mockResolvedValueOnce([]);
    await expect(revokedAssignment.provider.invoke({
      toolId: 'DwsBusiness',
      input: {
        args: ['doc', 'update', '--node', 'doc-a', '--content', '正文'],
        credentialMode: 'agent', confirmed: true,
      },
      authorization: { approved: true, source: 'human_approval', approvalId: 'approval-a' },
    }, revokedAssignment.context)).rejects.toThrow('原请求者当前已无权');
    expect(revokedAssignment.invoke).not.toHaveBeenCalled();
  });
});
