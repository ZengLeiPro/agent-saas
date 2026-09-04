import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentDwsAccount } from '@agent/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authFetch } from '@/lib/authFetch';
import { GroupAgentWorkspacePanel } from './GroupAgentWorkspacePanel';

vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));

const account = {
  accountId: 'account/member',
  displayName: '群前台账号',
  profileId: 'corp-a:member-a',
  corpId: 'corp-a',
  dingtalkUserId: 'member-a',
  status: 'active',
} as AgentDwsAccount;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const workspace = {
  approvals: [
    {
      approvalId: 'approval/1',
      runId: 'run-approval-1',
      conversationId: 'group-1',
      workConversationId: 'wc-1',
      toolName: 'DwsBusiness',
      displayName: '钉钉业务操作',
      input: { args: ['doc', 'update', '--node', 'doc-a'], token: '[REDACTED]' },
      createdAt: '2026-09-04T00:00:00.000Z',
    },
  ],
  bindings: [
    {
      bindingId: 'binding-1',
      accountId: account.accountId,
      agentId: 'agent-1',
      conversationId: 'group-1',
      activationState: 'active',
      enabled: true,
      revision: 4,
      policy: {
        enabled: true,
        membership: 'members',
        guest: 'deny',
        taskVisibility: 'conversation',
        completion: 'reply_to_work_conversation',
        liveDeny: true,
      },
      effectiveConfig: {
        identity: { displayName: '开开' },
        instructions: { system: '只处理客户资料' },
        knowledge: { contextEnabled: true, sourceIds: ['source-1'] },
        capabilities: {
          skillIds: ['skill-1'],
          toolNames: ['ContextSearch'],
          dwsResourceIds: [],
        },
        memory: { readAgent: true, readConversation: true, adminWriteConversation: true },
        access: { triggerRoles: ['member'], approvalRoles: ['org_admin'] },
        speech: { proactive: false, requireMention: true },
      },
      effectiveConfigComputation: {
        publishedAgent: {
          skillIds: ['skill-1', 'skill-2'],
          knowledgeSkillIds: [],
          sourceIds: ['source-1', 'source-2'],
          executionMode: 'dispatcher',
          enabled: true,
        },
        channelCeiling: {
          toolNames: ['ContextGet', 'ContextSearch', 'DwsBusiness'],
          contextSourceIds: ['source-1', 'source-2'],
          contextDirectoryAvailable: true,
        },
        groupNarrowing: {},
        liveOverrides: {
          bindingEnabled: true,
          liveDeny: true,
          accountStatus: 'active',
        },
      },
    },
  ],
  workspaces: [
    {
      bindingId: 'binding-1',
      conversationSpace: { conversationSpaceId: 'space-1', conversationId: 'group-1' },
      workConversations: [
        {
          workConversationId: 'wc-1',
          rootKey: 'root-1',
          sessionId: 'session-1',
          state: 'active',
          updatedAt: '2026-09-04T00:00:00.000Z',
          memories: [],
          workOrders: [
            {
              workOrderId: 'work/1',
              workConversationId: 'wc-1',
              shortId: 'W-123456789abc',
              title: '整理客户资料',
              state: 'failed',
              version: 3,
              currentAttemptNo: 1,
              control: { revision: 1, workerType: 'general' as const, supplements: [] },
              updatedAt: '2026-09-04T00:00:00.000Z',
              attempts: [
                {
                  attemptId: 'attempt-1',
                  status: 'failed',
                  runtimeRunId: 'run-1',
                  publishState: 'rejected' as 'pending' | 'published' | 'conflict' | 'rejected',
                },
              ],
            },
          ],
        },
      ],
      memories: [],
    },
  ],
  observedGroups: [
    {
      conversationId: 'group-1',
      lastEventAt: '2026-09-04T00:00:00.000Z',
      bindingId: 'binding-1',
    },
  ],
  deliveries: [
    {
      deliveryId: 'delivery/1',
      deliveryKind: 'completion',
      deliveryState: 'unknown',
      content: '任务可能已经发出',
      updatedAt: '2026-09-04T00:00:00.000Z',
      technicalEvidence: { receiptPresent: false, leaseFence: 1 },
    },
  ],
};

describe('GroupAgentWorkspacePanel', () => {
  beforeEach(() => {
    vi.mocked(authFetch)
      .mockReset()
      .mockImplementation(async (path, init) => {
        if (String(path).includes('/group-workspace?') && !init?.method)
          return jsonResponse(workspace);
        if (String(path).includes('/group-workspace?') && init?.method === 'PATCH')
          return jsonResponse({ ok: true });
        if (String(path).includes('/group-workspace/bindings?') && init?.method === 'POST')
          return jsonResponse({ ok: true }, 201);
        if (String(path).includes('/group-workspace/memories?') && init?.method === 'POST')
          return jsonResponse({ ok: true }, 201);
        if (String(path).includes('/action?') && init?.method === 'POST')
          return jsonResponse({ ok: true });
        if (String(path).includes('/reconcile?') && init?.method === 'POST')
          return jsonResponse({ ok: true });
        if (String(path).includes('/approvals/') && init?.method === 'POST')
          return jsonResponse({ status: 'queued' }, 202);
        return jsonResponse({ error: `unexpected ${String(path)}` }, 500);
      });
  });

  it('active 账号可从 Personal Stream 已观测群创建 shadow binding', async () => {
    const user = userEvent.setup();
    vi.mocked(authFetch).mockImplementation(async (path, init) => {
      if (String(path).includes('/group-workspace?') && !init?.method)
        return jsonResponse({
          ...workspace,
          observedGroups: [{
            conversationId: 'group/unbound',
            lastEventAt: '2026-09-04T01:00:00.000Z',
            bindingId: null,
          }],
        });
      if (String(path).includes('/group-workspace/bindings?') && init?.method === 'POST')
        return jsonResponse({ ok: true }, 201);
      return jsonResponse({ error: `unexpected ${String(path)}` }, 500);
    });
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    await user.click(await screen.findByRole('combobox', { name: '已观测群' }));
    await user.click(await screen.findByRole('option', { name: /group\/unbound/ }));
    await user.click(screen.getByRole('button', { name: '创建群配置' }));

    await waitFor(() => expect(vi.mocked(authFetch).mock.calls.some(([path, init]) => (
      path === '/api/agent-dws-accounts/account%2Fmember/group-workspace/bindings?tenantId=tenant-a'
      && init?.method === 'POST'
      && JSON.parse(String(init.body)).conversationId === 'group/unbound'
    ))).toBe(true));
  });

  it('paused 账号保留管理入口，但明确禁用新群配置创建', async () => {
    vi.mocked(authFetch).mockImplementation(async (path) => {
      if (String(path).includes('/group-workspace?')) return jsonResponse({
        ...workspace,
        observedGroups: [{
          conversationId: 'group/unbound',
          lastEventAt: '2026-09-04T01:00:00.000Z',
          bindingId: null,
        }],
      });
      return jsonResponse({ error: `unexpected ${String(path)}` }, 500);
    });
    render(<GroupAgentWorkspacePanel
      tenantId="tenant-a"
      accounts={[{ ...account, status: 'paused' } as AgentDwsAccount]}
    />);

    expect(await screen.findByText(/可查看并停用已有配置/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '创建群配置' }).hasAttribute('disabled')).toBe(true);
    cleanup();
  });

  it('展示 attempt 证据，并使用编码后的资源路径重试任务', async () => {
    const user = userEvent.setup();
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    expect(await screen.findByText('整理客户资料')).toBeTruthy();
    await user.click(screen.getByText('查看执行证据'));
    expect(screen.getByText(/attempt-1 · run run-1/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '重试' }));

    await waitFor(() =>
      expect(
        vi
          .mocked(authFetch)
          .mock.calls.some(
            ([path, init]) =>
              path ===
                '/api/agent-dws-accounts/account%2Fmember/group-workspace/work-orders/work%2F1/action?tenantId=tenant-a' &&
              init?.method === 'POST',
          ),
      ).toBe(true),
    );
  });

  it('unknown 投递只能通过人工终态确认进入重发', async () => {
    const user = userEvent.setup();
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    await user.click(await screen.findByRole('button', { name: '确认未发出' }));
    const call = vi
      .mocked(authFetch)
      .mock.calls.find(([path]) => String(path).includes('/reconcile?'));
    expect(call?.[0]).toBe(
      '/api/agent-dws-accounts/account%2Fmember/group-workspace/deliveries/delivery%2F1/reconcile?tenantId=tenant-a',
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual(
      expect.objectContaining({ outcome: 'confirmed_not_sent' }),
    );
  });

  it('管理员可在群工作台批准持久化 DWS 写操作', async () => {
    const user = userEvent.setup();
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    await user.click(await screen.findByRole('button', { name: '批准执行' }));
    const call = vi.mocked(authFetch).mock.calls.find(([path]) =>
      String(path).includes('/group-workspace/approvals/'));
    expect(call?.[0]).toBe(
      '/api/agent-dws-accounts/account%2Fmember/group-workspace/approvals/approval%2F1/decision?tenantId=tenant-a',
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      decision: 'approved',
      message: '组织管理员批准执行',
    });
  });

  it('完成任务存在待发布 manifest 时显示显式发布动作', async () => {
    const user = userEvent.setup();
    const work = workspace.workspaces[0].workConversations[0].workOrders[0];
    work.state = 'completed';
    work.attempts[0].status = 'completed';
    work.attempts[0].publishState = 'pending';
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    expect(screen.queryByRole('button', { name: '重试' })).toBeNull();
    await user.click(await screen.findByRole('button', { name: '发布产物' }));
    const call = vi.mocked(authFetch).mock.calls.find(([, init]) =>
      init?.method === 'POST' && JSON.parse(String(init.body)).action === 'publish');
    expect(call?.[0]).toBe(
      '/api/agent-dws-accounts/account%2Fmember/group-workspace/work-orders/work%2F1/action?tenantId=tenant-a',
    );
    work.state = 'failed';
    work.attempts[0].status = 'failed';
    work.attempts[0].publishState = 'rejected';
  });

  it('选择游客只读时同步提交允许游客的 membership', async () => {
    const user = userEvent.setup();
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    await screen.findByText('群 group-1');
    await user.click(screen.getByRole('combobox', { name: '游客访问' }));
    await user.click(await screen.findByRole('option', { name: '游客只读' }));
    await user.click(screen.getByRole('button', { name: '保存群配置' }));

    const call = vi.mocked(authFetch).mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body)).policy).toMatchObject({
      guest: 'shared_read_only',
      membership: 'members_and_guests',
    });
  });

  it('管理员可把事实写入当前 WorkConversation 记忆', async () => {
    const user = userEvent.setup();
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    await user.type(await screen.findByLabelText('新增话题记忆'), '客户要求周五前给方案');
    await user.click(screen.getByRole('button', { name: '保存记忆' }));

    const call = vi
      .mocked(authFetch)
      .mock.calls.find(
        ([path, init]) =>
          String(path).endsWith('/group-workspace/memories?tenantId=tenant-a') &&
          init?.method === 'POST',
      );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual(
      expect.objectContaining({
        bindingId: 'binding-1',
        workConversationId: 'wc-1',
        memoryScope: 'conversation',
        content: { text: '客户要求周五前给方案' },
        policyRevision: 4,
      }),
    );
  });

  it('保存完整群配置：身份、上下文、可见范围与角色', async () => {
    const user = userEvent.setup();
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    const displayName = await screen.findByLabelText('前台显示名');
    expect((screen.getByRole('switch', { name: '技能：skill-1' }) as HTMLButtonElement).dataset.state)
      .toBe('checked');
    expect((screen.getByRole('switch', { name: '工具：ContextSearch' }) as HTMLButtonElement).dataset.state)
      .toBe('checked');
    expect((screen.getByRole('switch', { name: '知识源：source-1' }) as HTMLButtonElement).dataset.state)
      .toBe('checked');
    await user.click(screen.getByRole('switch', { name: '技能：skill-2' }));
    await user.click(screen.getByRole('switch', { name: '工具：ContextGet' }));
    await user.click(screen.getByRole('switch', { name: '知识源：source-2' }));
    await user.clear(displayName);
    await user.type(displayName, '客户资料助手');
    const instructions = screen.getByLabelText('群 Agent 指令');
    await user.clear(instructions);
    await user.type(instructions, '只处理报价资料');
    await user.click(screen.getByRole('switch', { name: '启用企业上下文' }));
    await user.click(screen.getByRole('switch', { name: '读取 Agent 级记忆' }));
    await user.click(screen.getByRole('switch', { name: '工具：DwsBusiness' }));
    await user.type(screen.getByLabelText('钉钉资源范围'), 'doc:doc-a');
    await user.click(screen.getByRole('combobox', { name: '任务可见范围' }));
    await user.click(await screen.findByRole('option', { name: '仅发起人可见' }));
    await user.click(screen.getByRole('switch', { name: '可触发角色：member' }));
    await user.click(screen.getByRole('switch', { name: '可审批/管理角色：member' }));
    await user.click(screen.getByRole('button', { name: '保存群配置' }));

    const call = vi.mocked(authFetch).mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
      policy: { taskVisibility: 'requester_only' },
      effectiveConfig: {
        identity: { displayName: '客户资料助手' },
        instructions: { system: '只处理报价资料' },
        knowledge: { contextEnabled: false, sourceIds: ['source-1', 'source-2'] },
        capabilities: {
          skillIds: ['skill-1', 'skill-2'],
          toolNames: ['ContextSearch', 'ContextGet', 'DwsBusiness'],
          dwsResourceIds: ['doc:doc-a'],
        },
        memory: { readAgent: false, readConversation: true, adminWriteConversation: true },
        access: { triggerRoles: [], approvalRoles: ['org_admin', 'member'] },
        speech: { proactive: false, requireMention: true },
      },
    });
    expect(screen.getByText('当前仅支持群内 @ 前台账号触发；必须 @，不支持主动发言。')).toBeTruthy();
  });

  it('非候选能力不可新增，既有越界值只能显式移除', async () => {
    const narrowedWorkspace = structuredClone(workspace);
    narrowedWorkspace.bindings[0].effectiveConfig.capabilities.skillIds.push('skill-legacy');
    vi.mocked(authFetch).mockImplementation(async (path, init) => {
      if (String(path).includes('/group-workspace?') && !init?.method)
        return jsonResponse(narrowedWorkspace);
      return jsonResponse({ error: `unexpected ${String(path)}` }, 500);
    });
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    expect(await screen.findByRole('switch', { name: '技能：skill-1' })).toBeTruthy();
    expect(screen.queryByRole('switch', { name: '技能：skill-not-published' })).toBeNull();
    const legacy = screen.getByRole('switch', { name: '技能：移除非目录值 skill-legacy' });
    expect((legacy as HTMLButtonElement).dataset.state).toBe('checked');
    expect(screen.getByText('以下既有值不在当前目录中，只能保留或移除，不能新增：')).toBeTruthy();
  });

  it('空能力目录与不可用知识源目录展示明确限制并保留既有值', async () => {
    const emptyWorkspace = structuredClone(workspace);
    emptyWorkspace.bindings[0].effectiveConfigComputation.publishedAgent.skillIds = [];
    emptyWorkspace.bindings[0].effectiveConfigComputation.channelCeiling.toolNames = [];
    emptyWorkspace.bindings[0].effectiveConfigComputation.channelCeiling.contextDirectoryAvailable = false;
    vi.mocked(authFetch).mockImplementation(async (path, init) => {
      if (String(path).includes('/group-workspace?') && !init?.method)
        return jsonResponse(emptyWorkspace);
      return jsonResponse({ error: `unexpected ${String(path)}` }, 500);
    });
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    expect(await screen.findByText('当前 Agent 未发布可选技能，无法为该群新增技能。')).toBeTruthy();
    expect(screen.getByText('当前群入口未开放可选工具。')).toBeTruthy();
    expect(screen.getByText('知识源目录暂不可用；已保留当前配置，请刷新或检查账号的 Context 授权。')).toBeTruthy();
    expect(screen.getByText('当前保留：source-1')).toBeTruthy();
    expect(screen.getByText(/共享群目前只验证了钉钉文档命令/)).toBeTruthy();
    expect(screen.getByText(/doc:<nodeId>/)).toBeTruthy();
    expect(screen.queryByText(/drive:/)).toBeNull();
  });

  it('任务控制调用 amend、pause、resume、review 与 reassign API', async () => {
    const user = userEvent.setup();
    const work = workspace.workspaces[0].workConversations[0].workOrders[0];
    work.state = 'running';
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    await user.click(await screen.findByText('任务控制 · W-123456789abc'));
    await user.type(screen.getByLabelText('补充或变更要求'), '补一份报价说明');
    await user.click(screen.getByRole('button', { name: '补充任务' }));
    await waitFor(() => expect(vi.mocked(authFetch).mock.calls.some(([, init]) =>
      init?.method === 'POST' && JSON.parse(String(init.body)).action === 'amend',
    )).toBe(true));

    await user.click(screen.getByRole('button', { name: '暂停任务' }));
    await waitFor(() => expect(vi.mocked(authFetch).mock.calls.some(([, init]) =>
      init?.method === 'POST' && JSON.parse(String(init.body)).action === 'pause',
    )).toBe(true));

    await user.type(screen.getByLabelText('复核意见'), '请检查金额');
    expect((screen.getByRole('button', { name: '发起复核' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await user.click(screen.getByRole('combobox', { name: '执行 Worker' }));
    await user.click(await screen.findByRole('option', { name: '探索 Worker' }));
    await user.click(screen.getByRole('button', { name: '改派 Worker' }));
    await waitFor(() => expect(vi.mocked(authFetch).mock.calls.some(([, init]) =>
      init?.method === 'POST'
        && JSON.parse(String(init.body)).action === 'reassign'
        && JSON.parse(String(init.body)).workerType === 'explore',
    )).toBe(true));
    cleanup();
    work.state = 'paused';
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);
    await user.click(await screen.findByText('任务控制 · W-123456789abc'));
    await user.click(screen.getByRole('button', { name: '恢复任务' }));
    await waitFor(() =>
      expect(
        vi
          .mocked(authFetch)
          .mock.calls.some(
            ([, init]) =>
              init?.method === 'POST' && JSON.parse(String(init.body)).action === 'resume',
          ),
      ).toBe(true),
    );
    cleanup();
    work.state = 'failed';
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);
    await user.click(await screen.findByText('任务控制 · W-123456789abc'));
    await user.type(screen.getByLabelText('复核意见'), '请检查金额');
    await user.click(screen.getByRole('button', { name: '发起复核' }));
    await waitFor(() =>
      expect(
        vi
          .mocked(authFetch)
          .mock.calls.some(
            ([, init]) =>
              init?.method === 'POST' && JSON.parse(String(init.body)).action === 'review',
          ),
      ).toBe(true),
    );
    work.state = 'failed';
  });
});
