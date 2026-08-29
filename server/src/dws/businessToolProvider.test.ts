import { describe, expect, it, vi } from 'vitest';

import type { ToolCallContext } from '../agent/toolRuntime.js';
import { InMemoryGovernanceAuditStore } from '../data/governance-audit/store.js';
import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
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

function setup(input: {
  delegatedScopes?: string[];
  assignmentUnavailable?: boolean;
  sessionOrgAgentId?: string | null;
  sessionChannel?: 'web' | 'dingtalk' | 'cron';
  requesterProfiles?: Array<Record<string, unknown>>;
} = {}) {
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
      listForUser: vi.fn().mockResolvedValue(input.requesterProfiles ?? [{
        tenantId: 'tenant-a', userId: 'user-a', username: 'alice', profileId: 'requester-profile-secret',
        connectionStatus: 'connected', authenticated: true, refreshTokenValid: true,
      }]),
    } as never,
    userStore: { findById: vi.fn().mockReturnValue(user) } as never,
    sessionCatalog: {
      get: vi.fn().mockResolvedValue({
        sessionId: 'session-a', userId: 'user-a', username: 'alice', userRole: 'user',
        tenantId: 'tenant-a', channel: input.sessionChannel ?? 'dingtalk', cwd: '/workspace/agent', transcriptPath: 'x',
        ...(input.sessionOrgAgentId === null ? {} : { orgAgentId: input.sessionOrgAgentId ?? 'agent-a' }),
        createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
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
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'list', '--help'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['chat', 'message', 'list-all', '--help'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['drive', 'recent', '--help'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['todo', 'task', 'list', '--help'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'future-verb', '--help', '--verbose'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'create'], confirmed: true })).toBe('workspace_write');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'respond'], confirmed: true })).toBe('workspace_write');
    expect(resolveDwsBusinessRisk({ args: ['doc', 'delete'], confirmed: true })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['doc', 'delete', '--help'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['doc', '+delete', '--help'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['drive', 'file', 'download'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['drive', '+download', '--help'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['doc', 'get', '--output', '.dws/keys/token'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['mail', 'message', 'send', '--attachment', '.dws/keys/token'], confirmed: true })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['doc', 'export', 'get'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'future-verb'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'list', '--action=delete'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['auth', 'status'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['auth', 'login'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['auth', 'status', '--verbose'] })).toBe('dangerous');
    // TASK-256：skill 文档强制所有命令带 --format json，格式旗标不得再触发受限旗标误判。
    expect(resolveDwsBusinessRisk({ args: ['doc', 'read', '--format', 'json'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['report', 'inbox', '--format', 'json'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['auth', 'status', '--format', 'json'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['sheet', 'list', '-f', 'json'] })).toBe('safe');
    // TASK-256：补录 skill 文档证实但此前未登记的只读动作。
    expect(resolveDwsBusinessRisk({ args: ['aisearch', 'person', '--keyword', '张三'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['aisearch', 'behavior', '--types', 'all'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['aisearch', 'enterprise'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['minutes', 'list', 'mine', '--max', '10'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['minutes', 'list', 'all'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['minutes', 'list', 'shared'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['minutes', 'get', 'transcription'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['attendance', 'check', 'record'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['attendance', 'check', 'result'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['attendance', 'vacation', 'balance'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['attendance', 'vacation', 'types'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['attendance', 'report', 'columns'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['attendance', 'rules'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['report', 'inbox'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['mail', 'mailbox', 'profile'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['mail', 'message', 'verify'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['contact', 'user', 'profile'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['agoal', 'user', 'rules'] })).toBe('safe');
    // TASK-256：补录文档证实、受 confirmed 闸门约束的确认制写动作（分档仍为 write）。
    expect(resolveDwsBusinessRisk({ args: ['mail', 'rule', 'adjust', '--order', 'up'] })).toBe('workspace_write');
    expect(resolveDwsBusinessRisk({ args: ['drive', 'mkdir', '--name', '新目录'] })).toBe('workspace_write');
    expect(dwsBusinessToolDescriptor.resolveCallPolicy?.({ args: ['todo', 'list'] })).toEqual({ risk: 'safe' });
    expect(dwsBusinessToolDescriptor.resolveCallPolicy?.({ args: ['aisearch', 'person', '--keyword', '张三', '--format', 'json'] })).toEqual({ risk: 'safe' });
  });

  it('TASK-256 review 返工：位置参数不得把真实写命令降档为 read', () => {
    // review 复现：末尾位置参数命中读动词，曾把 send/create 降档为 safe，绕过 confirmed 闸门。
    expect(resolveDwsBusinessRisk({ args: ['chat', 'message', 'send', 'all', '--group', 'cid'], confirmed: true })).toBe('workspace_write');
    expect(resolveDwsBusinessRisk({ args: ['chat', 'message', 'send', 'status', '--group', 'cid'], confirmed: true })).toBe('workspace_write');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'create', 'info', '--title', 'x'], confirmed: true })).toBe('workspace_write');
    // 无 confirmed 时风险档不变（write），confirmed 闸门在 provider invoke 层拦截（见下个用例）。
    expect(resolveDwsBusinessRisk({ args: ['chat', 'message', 'send', 'all', '--group', 'cid'] })).toBe('workspace_write');
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'create', 'info', '--title', 'x'] })).toBe('workspace_write');
  });

  it('TASK-256 review 返工：缺 confirmed 时 provider 不得调用底层 invoke', async () => {
    const { provider, invoke, auditStore, context } = setup();
    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['chat', 'message', 'send', 'all', '--group', 'cid'], credentialMode: 'agent' },
      authorization: { approved: true, source: 'policy_auto' },
    }, context)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    expect(auditStore.events.at(-1)?.metadata).toMatchObject({
      commandPath: 'chat.message.send.all',
      policySource: 'legacy_verb_fallback',
      policyCliVersionCatalogs: '1.0.55,1.0.60',
    });
  });

  it('TASK-256 review 返工：全路径写扫描后正常只读路径仍为 safe，拒绝语义不变', () => {
    expect(resolveDwsBusinessRisk({ args: ['minutes', 'list', 'all'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['aisearch', 'person'] })).toBe('safe');
    // 路径含写动词但文档证实纯查询的例外命令保持 safe。
    expect(resolveDwsBusinessRisk({ args: ['doc', 'comment', 'list', '--node', 'nid'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['todo', 'comment', 'list', '--task-id', 'tid'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['mail', 'auto-reply', 'get'] })).toBe('safe');
    expect(resolveDwsBusinessRisk({ args: ['aitable', 'form', 'share', 'get', '--base-id', 'b'] })).toBe('safe');
    // 例外表外的同类路径形态仍按写动词分档（fail closed）。
    expect(resolveDwsBusinessRisk({ args: ['doc', 'comment', 'create', '--node', 'nid'], confirmed: true })).toBe('workspace_write');
    // destructive / forbidden 既有拒绝语义不变。
    expect(resolveDwsBusinessRisk({ args: ['doc', 'delete'], confirmed: true })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['drive', 'file', 'download'] })).toBe('dangerous');
    expect(resolveDwsBusinessRisk({ args: ['auth', 'login'] })).toBe('dangerous');
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
      policySource: 'cli_schema',
      policyCliVersionCatalogs: '1.0.55,1.0.60',
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

  it('requester 模式允许在请求者自己的普通 Session 检查能力中心连接', async () => {
    const { provider, invoke, context, auditStore } = setup({
      sessionOrgAgentId: null,
      sessionChannel: 'web',
    });

    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['auth', 'status'], credentialMode: 'requester' },
      authorization: { approved: true, source: 'policy_auto' },
    }, context)).resolves.toMatchObject({ content: '{"ok":true}' });

    expect(invoke.mock.calls[0]![0].input.command).toContain("'dws' 'auth' 'status' '--profile' 'requester-profile-secret'");
    expect(auditStore.events[0]).toMatchObject({
      targetType: 'user',
      targetId: 'user-a',
      metadata: { credentialMode: 'requester', sessionBound: false },
    });
  });

  it('agent 模式在普通 Session 仍然拒绝借用未绑定的企业专家账号', async () => {
    const { provider, invoke, context } = setup({ sessionOrgAgentId: null, sessionChannel: 'web' });

    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['calendar', 'event', 'list'], credentialMode: 'agent' },
      authorization: { approved: true, source: 'policy_auto' },
    }, context)).rejects.toThrow('不一致项：session.orgAgentId');
    expect(invoke).not.toHaveBeenCalled();
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

  it('平台管理员可跨租户恢复 Session，requester 仍使用归属者 profile 并按 operator 审计', async () => {
    const { provider, invoke, context, auditStore } = setup();
    const platformAdmin = {
      id: 'platform-admin', username: 'root', role: 'admin' as const,
      tenantId: DEFAULT_TENANT_ID, disabled: false,
    };

    await provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['minutes', '+list-all'], credentialMode: 'requester' },
      authorization: { approved: true, source: 'policy_auto' },
    }, {
      ...context,
      channelContext: { ...context.channelContext, user: platformAdmin },
      workspace: {
        ...context.workspace,
        userId: platformAdmin.id,
        username: platformAdmin.username,
        tenantId: platformAdmin.tenantId,
      },
    });

    expect(invoke.mock.calls[0]![0].input.command).toContain("'--profile' 'requester-profile-secret'");
    expect(auditStore.events[0]).toMatchObject({
      actorUserId: platformAdmin.id,
      actorTenantId: DEFAULT_TENANT_ID,
      metadata: { sessionOwnerTenantId: 'tenant-a', operatorTenantId: DEFAULT_TENANT_ID },
    });
  });

  it('异租户组织管理员不能跨租户使用 Session 归属者的 requester profile', async () => {
    const { provider, invoke, context, auditStore, logger } = setup();
    const otherTenantAdmin = {
      id: 'admin-b', username: 'admin-b', role: 'admin' as const, tenantId: 'tenant-b', disabled: false,
    };

    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['minutes', '+list-all'], credentialMode: 'requester' },
      authorization: { approved: true, source: 'policy_auto' },
    }, {
      ...context,
      channelContext: { ...context.channelContext, user: otherTenantAdmin },
      workspace: {
        ...context.workspace,
        userId: otherTenantAdmin.id,
        username: otherTenantAdmin.username,
        tenantId: otherTenantAdmin.tenantId,
      },
    })).rejects.toThrow('不一致项：operator.sessionOwnerTenantScope');

    expect(invoke).not.toHaveBeenCalled();
    expect(auditStore.events.at(-1)).toMatchObject({
      actorUserId: otherTenantAdmin.id,
      actorTenantId: 'tenant-b',
      reason: 'DWS_BUSINESS_SUBJECT_MISMATCH',
      metadata: {
        mismatchFields: ['operator.sessionOwnerTenantScope'],
        sessionOwnerUserId: 'user-a',
        sessionOwnerTenantId: 'tenant-a',
        operatorUserId: otherTenantAdmin.id,
        operatorTenantId: 'tenant-b',
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"operatorTenantId":"tenant-b"'));
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
    })).rejects.toThrow('不一致项：operator.sessionOwnerTenantScope');

    expect(invoke).not.toHaveBeenCalled();
    expect(auditStore.events.at(-1)).toMatchObject({
      actorUserId: otherUser.id,
      actorPersona: 'member',
      reason: 'DWS_BUSINESS_SUBJECT_MISMATCH',
      metadata: {
        mismatchFields: ['operator.sessionOwnerTenantScope'],
        sessionOwnerUserId: 'user-a',
        operatorUserId: otherUser.id,
      },
    });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('"operatorUserId":"user-b"'));
  });

  it('个人 Cron 未绑定企业专家时 requester 模式按创建者连接执行', async () => {
    const { provider, invoke, context, auditStore } = setup({ sessionOrgAgentId: null, sessionChannel: 'cron' });

    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['drive', 'recent', '--help'], credentialMode: 'requester' },
      authorization: { approved: true, source: 'policy_auto' },
    }, context)).resolves.toMatchObject({ content: '{"ok":true}' });

    expect(invoke.mock.calls[0]![0].input.command).toContain("'dws' 'drive' 'recent' '--help' '--profile' 'requester-profile-secret'");
    expect(auditStore.events[0]).toMatchObject({
      targetType: 'user',
      targetId: 'user-a',
      metadata: { credentialMode: 'requester', sessionBound: false },
    });
  });

  it('agent 模式在未绑定企业专家的 cron Session 仍返回可操作错误', async () => {
    const { provider, invoke, context } = setup({ sessionOrgAgentId: null, sessionChannel: 'cron' });

    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['calendar', 'event', 'list'], credentialMode: 'agent' },
      authorization: { approved: true, source: 'policy_auto' },
    }, context)).rejects.toThrow('请在目标企业专家会话中重新创建该定时任务');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('个人 Cron 身份漂移时 requester 模式 fail closed', async () => {
    const { provider, invoke, context } = setup({ sessionOrgAgentId: null, sessionChannel: 'cron' });

    await expect(provider.invoke({
      toolId: 'DwsBusiness',
      input: { args: ['drive', 'recent', '--help'], credentialMode: 'requester' },
      authorization: { approved: true, source: 'policy_auto' },
    }, {
      ...context,
      workspace: { ...context.workspace, userId: 'other-user' },
    })).rejects.toThrow('不一致项：workspace.userId');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('个人 Cron requester 连接缺失或存在多连接歧义时不回退企业专家', async () => {
    for (const profiles of [
      [],
      [
        {
          tenantId: 'tenant-a', userId: 'user-a', username: 'alice', profileId: 'profile-1',
          connectionStatus: 'connected', authenticated: true, refreshTokenValid: true,
        },
        {
          tenantId: 'tenant-a', userId: 'user-a', username: 'alice', profileId: 'profile-2',
          connectionStatus: 'connected', authenticated: true, refreshTokenValid: true,
        },
      ],
    ]) {
      const { provider, invoke, context } = setup({
        sessionOrgAgentId: null,
        sessionChannel: 'cron',
        requesterProfiles: profiles as never,
      });

      await expect(provider.invoke({
        toolId: 'DwsBusiness',
        input: { args: ['auth', 'status'], credentialMode: 'requester' },
        authorization: { approved: true, source: 'policy_auto' },
      }, context)).rejects.toThrow(/没有已连接的钉钉账号|存在多个钉钉账号/);
      expect(invoke).not.toHaveBeenCalled();
    }
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
