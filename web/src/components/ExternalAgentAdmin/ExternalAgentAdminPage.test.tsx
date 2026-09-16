import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authFetch } from '@/lib/authFetch';
import { ExternalAgentAdminPage } from './ExternalAgentAdminPage';

vi.mock('@/lib/authFetch', () => ({ authFetch: vi.fn() }));

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  vi.mocked(authFetch).mockImplementation(async (path) => {
    const url = String(path);
    if (url.startsWith('/api/admin/external-agent-clients')) {
      return json({
        clients: [
          {
            clientId: 'client-a',
            name: 'ERP',
            serviceAccountUserId: 'svc-a',
            keyPrefix: 'ky_ext_demo',
            effectiveStatus: 'active',
            allowedConnectionIds: ['dbc-1'],
            allowedAgentIds: ['oa-1'],
          },
        ],
      });
    }
    if (url.startsWith('/api/admin/external-database-connections')) {
      return json({ connections: [] });
    }
    if (url.startsWith('/api/admin/external-agent-operations')) {
      return json({
        conversations: [],
        executions: [],
        queryAudit: [],
        budgetAlerts: [],
        billingSummary: {
          balanceCredits: 88,
          lowBalance: false,
          currentMonthCreditsUsed: 12,
          currentMonthRevenueYuan: 0.12,
        },
        usageSummary: {
          organization: [],
          account: [],
          model: [],
          connection: [],
          client: [
            {
              key: 'client-a',
              executionCount: 2,
              inputTokens: 10,
              outputTokens: 5,
              chargedCredits: 12,
              revenueYuan: 0.12,
            },
          ],
        },
      });
    }
    throw new Error(`unexpected path ${url}`);
  });
});

describe('ExternalAgentAdminPage', () => {
  it('loads tenant-scoped clients and renders attributed billing operations', async () => {
    render(<ExternalAgentAdminPage tenantId="tenant-a" />);
    expect(await screen.findByText('ERP')).toBeTruthy();
    expect((screen.getByDisplayValue('tenant-a') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '会话与审计' }));
    expect(await screen.findByText('外部调用费用归因')).toBeTruthy();
    expect(screen.getByText(/15 tokens/)).toBeTruthy();
    expect(vi.mocked(authFetch)).toHaveBeenCalledWith(
      '/api/admin/external-agent-operations?tenantId=tenant-a',
    );
  });
});
