import { describe, expect, it, vi } from 'vitest';

import type { ToolCallContext } from '../agent/toolRuntime.js';
import { InMemoryGovernanceAuditStore } from '../data/governance-audit/store.js';
import {
  DwsBusinessToolProvider,
  deriveDwsAgentDelegationResourceId,
  dwsBusinessToolDescriptor,
  resolveDwsBusinessRisk,
} from './businessToolProvider.js';

const account = {
  accountId: 'account-a', tenantId: 'tenant-a', agentId: 'agent-a', displayName: '专家甲',
  loginId: 'login-a', profileId: 'agent-profile-secret', status: 'active', runtimeStatus: 'ready',
  eventKinds: ['at_me', 'all_direct'], revision: 1, createdAt: '2026-08-25T00:00:00.000Z',
  createdBy: 'admin-a', updatedAt: '2026-08-25T00:00:00.000Z', updatedBy: 'admin-a',
} as const;

const user = {
  id: 'user-a', username: 'alice', role: 'user' as const, tenantId: 'tenant-a',
  dingtalkStaffId: 'sender-a', disabled: false,
};

function setup(input: { delegatedScopes?: string[]; assignmentUnavailable?: boolean } = {}) {
  const auditStore = new InMemoryGovernanceAuditStore();
  const invoke = vi.fn().mockResolvedValue({
    status: 'success',
    content: '{"ok":true}',
    audit: [{
      provider: 'server-remote', operation: 'shell', status: 'success',
      error: 'command used --profile agent-profile-secret token=raw-token',
    }],
    metadata: { exitCode: 0, command: 'dws --profile agent-profile-secret' },
  });
  const listEffectiveResourceIds = input.assignmentUnavailable
    ? vi.fn().mockRejectedValue(new Error('assignment unavailable'))
    : vi.fn().mockResolvedValue((input.delegatedScopes ?? [
      deriveDwsAgentDelegationResourceId('account-a', ['calendar', 'event', 'list', '--today']),
    ]).map(resourceId => ({ resourceId, bindingId: 'assignment-a', assignmentVersion: 3 })));
  const logger = { warn: vi.fn() };
  const provider = new DwsBusinessToolProvider({
    agentCwd: '/workspace',
    accountStore: {
      listForTenant: vi.fn().mockResolvedValue([account]),
    } as never,
    assignmentStore: { listEffectiveResourceIds } as never,
    connectionStore: {
      listForUser: vi.fn().mockResolvedValue([{
        tenantId: 'tenant-a', userId: 'user-a', username: 'alice', profileId: 'requester-profile-secret',
        connectionStatus: 'connected', authenticated: true, refreshTokenValid: true,
      }]),
    } as never,
    userStore: { findById: vi.fn().mockReturnValue(user) } as never,
    sessionCatalog: {
      get: vi.fn().mockResolvedValue({
        sessionId: 'session-a', userId: 'user-a', username: 'alice', userRole: 'user',
        tenantId: 'tenant-a', channel: 'dingtalk', cwd: '/workspace/agent', transcriptPath: 'x',
        orgAgentId: 'agent-a', createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
      }),
    },
    auditStore,
    resolveServerRemote: vi.fn().mockResolvedValue({ baseUrl: 'https://hand.test', authToken: 'remote-token' }),
    createTransport: () => ({ invoke }),
    logger,
  });
  const executionAudit = { records: [], record: vi.fn() };
  const context: ToolCallContext = {
    channelContext: { channel: 'dingtalk', sessionOwner: user },
    workspace: {
      id: 'workspace-a', root: '/workspace/agent', userId: 'user-a', username: 'alice',
      tenantId: 'tenant-a', sessionId: 'session-a', executionTarget: 'server-remote',
    },
    sessionId: 'session-a', runId: 'run-a', toolCallId: 'tool-a', invocationId: 'invocation-a',
    executionAudit,
  };
  return { provider, invoke, auditStore, context, executionAudit, listEffectiveResourceIds, logger };
}

describe('DwsBusinessToolProvider', () => {
  it('按命令动作动态分档，并对未知或破坏性动作 fail closed', () => {
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'list'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['minutes', '+list-all'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'create'], confirmed: true })).toBe('workspace_write');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'respond'], confirmed: true })).toBe('workspace_write');
    expect(resolveDwsBusinessRisk({ args: ['doc', 'delete'], confirmed: true })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['drive', 'file', 'download'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['doc', 'get', '--output', '.dws/keys/token'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['mail', 'message', 'send', '--attachment', '.dws/keys/token'], confirmed: true })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['doc', 'export', 'get'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'future-verb'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'list', '--action=delete'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['auth', 'status'] })).toBe('dangerous');
    expect(dwsBusinessToolDescriptor.resolveCallPolicy?.({ args: ['todo', 'list'] })).toEqual({ risk: 'safe' });
  });

  it('使用专家 profile 在隔离 connector workspace 执行读命令并写入治理审计', async () => {
    const { provider, invoke, auditStore, context, executionAudit } = setup();

    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['calendar', 'event', 'list', '--today'], credentialMode: 'agent' },
      authorization: { approved: true, source: 'policy_auto' },
    }, context)).resolves.toMatchObject({ content: '{"ok":true}', metadata: { exitCode: 0 } });

    const request = invoke.mock.calls[0]![0];
    expect(request.toolName).toBe('Shell');
    expect(request.input.command).toContain("'dws' 'calendar' 'event' 'list' '--today'");
    expect(request.input.command).toContain("'--profile' 'agent-profile-secret' '--format' 'json'");
    expect(request.context.workspace).toMatchObject({
      userId: 'account-a', tenantId: 'tenant-a', executionTarget: 'server-remote',
    });
    expect(executionAudit.record).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.not.stringContaining('agent-profile-secret'),
    }));
    expect(JSON.stringify(executionAudit.record.mock.calls)).not.toContain('raw-token');
    expect(auditStore.events.map(event => event.result)).toEqual(['intent', 'succeeded']);
    expect(auditStore.events[0]?.metadata).toMatchObject({
      commandPath: 'calendar.event.list',
      delegationBindingId: 'assignment-a',
      delegationAssignmentVersion: 3,
    });
    expect(JSON.stringify(auditStore.events)).not.toContain('agent-profile-secret');
    expect(JSON.stringify(auditStore.events)).not.toContain('remote-token');
  });

  it('输出脱敏覆盖 camelCase credential 字段', async () => {
    const { provider, invoke, context } = setup({
      delegatedScopes: [deriveDwsAgentDelegationResourceId('account-a', ['calendar', 'event', 'list'])],
    });
    invoke.mockResolvedValueOnce({
      status: 'success',
      content: '{"accessToken":"access-secret","refreshToken":"refresh-secret","clientSecret":"client-secret"}',
    });

    const result = await provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['calendar', 'event', 'list'], credentialMode: 'agent' },
      authorization: { approved: true, source: 'policy_auto' },
    }, context);

    expect(result?.content).toContain('[REDACTED]');
    expect(result?.content).not.toMatch(/access-secret|refresh-secret|client-secret/);
  });

  it('Agent credential 对未显式委托的敏感模块和策略不可用状态 fail closed', async () => {
    for (const module of ['mail', 'contact', 'oa', 'calendar']) {
      const { provider, invoke, auditStore, context, listEffectiveResourceIds } = setup({ delegatedScopes: [] });
      await expect(provider.invoke({
        toolId: 'DwsBusiness',
        input: { args: [module, 'message', 'list'], credentialMode: 'agent' },
        authorization: { approved: true, source: 'policy_auto' },
      }, context)).rejects.toThrow('委托权限');
      expect(listEffectiveResourceIds).toHaveBeenCalledWith('tenant-a', 'user-a', 'dws_delegation');
      expect(invoke).not.toHaveBeenCalled();
      expect(auditStore.events.at(-1)).toMatchObject({
        reason: 'DWS_BUSINESS_AGENT_DELEGATION_DENIED', result: 'failed',
      });
    }

    const unavailable = setup({ assignmentUnavailable: true });
    await expect(unavailable.provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['mail', 'message', 'list'], credentialMode: 'agent' },
      authorization: { approved: true, source: 'policy_auto' },
    }, unavailable.context)).rejects.toThrow('委托权限');
    expect(unavailable.invoke).not.toHaveBeenCalled();
  });

  it('Agent credential 委托绑定账号与完整参数，目标资源或 payload 变化即拒绝', async () => {
    const exact = setup({ delegatedScopes: [
      deriveDwsAgentDelegationResourceId('account-a', ['mail', 'message', 'list']),
    ] });
    await expect(exact.provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['mail', 'message', 'list'], credentialMode: 'agent' },
      authorization: { approved: true, source: 'policy_auto' },
    }, exact.context)).resolves.toMatchObject({ content: '{"ok":true}' });

    await expect(exact.provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['mail', 'message', 'list', '--folder-id', 'other'], credentialMode: 'agent' },
      authorization: { approved: true, source: 'policy_auto' },
    }, exact.context)).rejects.toThrow('委托权限');
    expect(exact.invoke).toHaveBeenCalledOnce();
  });

  it('requester 模式只从可信连接记录选择唯一 profile，写命令自动追加 --yes', async () => {
    const { provider, invoke, context } = setup();

    await provider.invoke({
      toolId: 'DwsBusiness',
      input: {
        args: ['todo', 'task', 'create', '--subject', '跟进客户'],
        credentialMode: 'requester',
        confirmed: true,
      },
      authorization: { approved: true, source: 'policy_auto' },
    }, context);

    const request = invoke.mock.calls[0]![0];
    expect(request.input.command).toContain("'--profile' 'requester-profile-secret'");
    expect(request.input.command).toContain("'--yes'");
    expect(request.context.workspace).toMatchObject({ userId: 'user-a', username: 'alice' });
  });

  it('管理员恢复其他用户会话时按会话归属者解析 requester，允许 workspace 保持当前操作者身份', async () => {
    const { provider, invoke, context, auditStore } = setup();
    const admin = {
      id: 'admin-a', username: 'admin', role: 'admin' as const, tenantId: 'tenant-a', disabled: false,
    };

    await provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['minutes', '+list-all'], credentialMode: 'requester' },
      authorization: { approved: true, source: 'policy_auto' },
    }, {
      ...context,
      channelContext: { ...context.channelContext, user: admin },
      workspace: { ...context.workspace, userId: admin.id, username: admin.username },
    });

    const request = invoke.mock.calls[0]![0];
    expect(request.input.command).toContain("'--profile' 'requester-profile-secret'");
    expect(request.context.workspace).toMatchObject({ userId: 'user-a', username: 'alice' });
    expect(auditStore.events[0]).toMatchObject({
      actorUserId: admin.id,
      actorPersona: 'org_admin',
      metadata: { sessionOwnerUserId: 'user-a', operatorUserId: admin.id, operatorRole: 'admin' },
    });
  });

  it('普通用户不能跨 Session 使用归属者的 requester profile', async () => {
    const { provider, invoke, context, auditStore, logger } = setup();
    const otherUser = {
      id: 'user-b', username: 'bob', role: 'user' as const, tenantId: 'tenant-a', disabled: false,
    };

    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['minutes', '+list-all'], credentialMode: 'requester' },
      authorization: { approved: true, source: 'policy_auto' },
    }, {
      ...context,
      channelContext: { ...context.channelContext, user: otherUser },
      workspace: { ...context.workspace, userId: otherUser.id, username: otherUser.username },
    })).rejects.toThrow('不一致项：operator.sessionOwnerDelegation');

    expect(invoke).not.toHaveBeenCalled();
    expect(auditStore.events.at(-1)).toMatchObject({
      actorUserId: otherUser.id,
      actorPersona: 'member',
      reason: 'DWS_BUSINESS_SUBJECT_MISMATCH',
      metadata: {
        mismatchFields: ['operator.sessionOwnerDelegation'],
        sessionOwnerUserId: 'user-a',
        operatorUserId: otherUser.id,
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"operatorUserId":"user-b"'));
  });

  it('拒绝未确认写操作、外部 profile 参数与身份漂移', async () => {
    const { provider, invoke, context, auditStore, logger } = setup();
    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['chat', 'message', 'send'] },
      authorization: { approved: true, source: 'policy_auto' },
    }, context)).rejects.toThrow('缺少用户明确确认');
    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['calendar', 'event', 'list', '--profile=other'] },
      authorization: { approved: true, source: 'policy_auto' },
    }, context)).rejects.toThrow('受限参数');
    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['calendar', 'event', 'list'] },
      authorization: { approved: true, source: 'policy_auto' },
    }, {
      ...context,
      workspace: { ...context.workspace, userId: 'other-user' },
    })).rejects.toThrow('不一致项：workspace.userId');
    expect(invoke).not.toHaveBeenCalled();
    expect(auditStore.events.at(-1)).toMatchObject({
      reason: 'DWS_BUSINESS_SUBJECT_MISMATCH',
      metadata: { mismatchFields: ['workspace.userId'], workspaceUserId: 'other-user' },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"mismatchFields":["workspace.userId"]'));
  });
});
