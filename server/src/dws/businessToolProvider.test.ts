import { describe, expect, it, vi } from 'vitest';

import type { ToolCallContext } from '../agent/toolRuntime.js';
import { InMemoryGovernanceAuditStore } from '../data/governance-audit/store.js';
import {
  DwsBusinessToolProvider,
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

function setup() {
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
  const provider = new DwsBusinessToolProvider({
    agentCwd: '/workspace',
    accountStore: {
      listForTenant: vi.fn().mockResolvedValue([account]),
    } as never,
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
  return { provider, invoke, auditStore, context, executionAudit };
}

describe('DwsBusinessToolProvider', () => {
  it('按命令动作动态分档，并对未知或破坏性动作 fail closed', () => {
    expect(resolveDwsBusinessRisk({ args: ['calendar', 'event', 'list'] })).toBe('safe');
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
    expect(JSON.stringify(auditStore.events)).not.toContain('agent-profile-secret');
    expect(JSON.stringify(auditStore.events)).not.toContain('remote-token');
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

  it('拒绝未确认写操作、外部 profile 参数与身份漂移', async () => {
    const { provider, invoke, context } = setup();
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
    })).rejects.toThrow('绑定不一致');
    expect(invoke).not.toHaveBeenCalled();
  });
});
