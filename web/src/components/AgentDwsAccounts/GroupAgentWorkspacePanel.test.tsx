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
  status: 'active',
} as AgentDwsAccount;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const workspace = {
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
        knowledge: { contextEnabled: true, sourceIds: ['source-1'] },
        capabilities: { skillIds: ['skill-1'], toolNames: ['ContextSearch'] },
        access: { triggerRoles: ['member'], approvalRoles: ['org_admin'] },
        speech: { proactive: false, requireMention: true },
      },
    },
  ],
  workspaces: [
    {
      bindingId: 'binding-1',
      workOrders: [
        {
          workOrderId: 'work/1',
          shortId: 'W-123456789abc',
          title: '整理客户资料',
          state: 'failed',
          version: 3,
          currentAttemptNo: 1,
          control: { revision: 1, workerType: 'general' as const, supplements: [] },
          updatedAt: '2026-09-04T00:00:00.000Z',
          attempts: [{ attemptId: 'attempt-1', status: 'failed', runtimeRunId: 'run-1',
            publishState: 'rejected' as 'pending' | 'published' | 'conflict' | 'rejected' }],
        },
      ],
      memories: [],
    },
  ],
  deliveries: [
    {
      deliveryId: 'delivery/1',
      deliveryKind: 'completion',
      deliveryState: 'unknown',
      content: '任务可能已经发出',
      updatedAt: '2026-09-04T00:00:00.000Z',
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
        if (String(path).includes('/action?') && init?.method === 'POST')
          return jsonResponse({ ok: true });
        if (String(path).includes('/reconcile?') && init?.method === 'POST')
          return jsonResponse({ ok: true });
        return jsonResponse({ error: `unexpected ${String(path)}` }, 500);
      });
  });

  it('展示 attempt 证据并使用编码后的资源路径重试', async () => {
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

  it('完成任务存在待发布 manifest 时显示显式发布动作', async () => {
    const user = userEvent.setup();
    const work = workspace.workspaces[0].workOrders[0];
    work.state = 'completed';
    work.attempts[0].status = 'completed';
    work.attempts[0].publishState = 'pending';
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

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

  it('保存完整群配置：身份、上下文、可见范围与角色', async () => {
    const user = userEvent.setup();
    render(<GroupAgentWorkspacePanel tenantId="tenant-a" accounts={[account]} />);

    const displayName = await screen.findByLabelText('前台显示名');
    await user.clear(displayName);
    await user.type(displayName, '客户资料助手');
    await user.click(screen.getByRole('switch', { name: '启用企业上下文' }));
    await user.click(screen.getByRole('switch', { name: '启用钉钉业务工具' }));
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
        knowledge: { contextEnabled: false },
        capabilities: { toolNames: ['ContextSearch', 'DwsBusiness'] },
        access: { triggerRoles: [], approvalRoles: ['org_admin', 'member'] },
        speech: { proactive: false, requireMention: true },
      },
    });
    expect(screen.getByText('当前仅支持群内 @ 前台账号触发；必须 @，不支持主动发言。')).toBeTruthy();
  });

  it('任务控制调用 amend、pause、resume、review 与 reassign API', async () => {
    const user = userEvent.setup();
    const work = workspace.workspaces[0].workOrders[0];
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
    await user.click(screen.getByRole('button', { name: '发起复核' }));
    await waitFor(() => expect(vi.mocked(authFetch).mock.calls.some(([, init]) =>
      init?.method === 'POST' && JSON.parse(String(init.body)).action === 'review',
    )).toBe(true));

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
    await waitFor(() => expect(vi.mocked(authFetch).mock.calls.some(([, init]) =>
      init?.method === 'POST' && JSON.parse(String(init.body)).action === 'resume',
    )).toBe(true));
    work.state = 'failed';
  });
});
