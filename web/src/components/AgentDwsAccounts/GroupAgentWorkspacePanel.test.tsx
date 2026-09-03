import { render, screen, waitFor } from '@testing-library/react';
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
        access: { triggerRoles: ['member'], approvalRoles: ['admin'] },
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
          title: '整理客户资料',
          state: 'failed',
          version: 3,
          currentAttemptNo: 1,
          updatedAt: '2026-09-04T00:00:00.000Z',
          attempts: [{ attemptId: 'attempt-1', status: 'failed', runtimeRunId: 'run-1' }],
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
});
