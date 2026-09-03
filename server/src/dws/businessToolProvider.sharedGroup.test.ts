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
  const listEffectiveResourceIds = vi.fn().mockResolvedValue([]);
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
      capabilities: { skillIds: [], toolNames: ['DwsBusiness'] },
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
  return { provider, invoke, context, listEffectiveResourceIds };
}

describe('DwsBusinessToolProvider 组织群动作矩阵', () => {
  it('mapped 与未映射访客都可使用 Agent 凭据读取已登记共享数据', async () => {
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
      expect(test.listEffectiveResourceIds).not.toHaveBeenCalled();
      expect(test.invoke.mock.calls[0]![0].context.workspace).toMatchObject({
        userId: 'account-a',
        tenantId: 'tenant-a',
        executionTarget: 'server-remote',
      });
    }
  });

  it('低风险写只允许 mapped、approvalRoles 命中且 confirmed=true', async () => {
    const allowed = setup({ assurance: 'mapped', actorRole: 'member', approvalRoles: ['member'] });
    await expect(
      allowed.provider.invoke(
        {
          toolId: 'DwsBusiness',
          input: {
            args: ['doc', 'create', '--title', '群文档', '--content', '正文'],
            credentialMode: 'agent',
            confirmed: true,
          },
          authorization: { approved: true, source: 'policy_auto' },
        },
        allowed.context,
      ),
    ).resolves.toMatchObject({ content: '{"ok":true}' });
    expect(allowed.invoke.mock.calls[0]![0].input.command).toContain("'--yes'");

    for (const test of [
      setup({ assurance: 'unmapped', approvalRoles: ['member'] }),
      setup({ assurance: 'mapped', actorRole: 'member', approvalRoles: ['org_admin'] }),
    ]) {
      await expect(
        test.provider.invoke(
          {
            toolId: 'DwsBusiness',
            input: {
              args: ['doc', 'create', '--title', '群文档', '--content', '正文'],
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
});
