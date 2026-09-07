import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authFetch = vi.fn();
vi.mock('@/lib/authFetch', () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));

import { KyAppDeliveryHealthPanel, KyAppTenantUsagePanel } from './KyAppDeliveryPanels';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('KY App 交付看板', () => {
  beforeEach(() => authFetch.mockReset());

  it('客户概览展示真实口径与三天预警', async () => {
    authFetch.mockResolvedValue(
      json({
        overview: {
          currentMonthCreditsUsed: 100,
          balanceCredits: 20,
          estimatedDaysRemaining: 2,
          topUsers: [{ userId: 'u1', name: '张三', creditsUsed: 80 }],
          topCapabilities: [{ capabilityId: 'order.search', calls: 6 }],
          weeklyTrend: [{ date: '2026-09-07', creditsUsed: 10 }],
          capabilityMetric: 'call_count',
        },
      }),
    );
    render(<KyAppTenantUsagePanel tenantId="tenant-a" />);
    expect(await screen.findByText('AI 使用概览')).toBeTruthy();
    expect(screen.getByText(/预计还能使用 2 天/)).toBeTruthy();
    expect(screen.getByText('order.search')).toBeTruthy();
    expect(authFetch).toHaveBeenCalledWith('/api/app-contract/v1/usage?tenantId=tenant-a', expect.objectContaining({ cache: 'no-store' }));
  });

  it('平台健康度展示组织与来源说明', async () => {
    authFetch.mockResolvedValue(
      json({
        items: [
          {
            installationId: 'iid-1',
            tenantId: 't1',
            tenantName: '客户甲',
            systemId: 'erp',
            deliveredAt: '2026-09-01T00:00:00Z',
            loginPenetration: 0.5,
            weeklyActiveAskers: 3,
            consumptionRate: 0.2,
            estimatedDaysRemaining: 8,
            lastUsageAt: null,
            offboardingStatus: 'active',
          },
        ],
      }),
    );
    render(<KyAppDeliveryHealthPanel />);
    expect(await screen.findByText('客户甲')).toBeTruthy();
    expect(screen.getByText('3 人')).toBeTruthy();
    await waitFor(() =>
      expect(authFetch).toHaveBeenCalledWith('/api/app-contract/v1/deliveries/health', expect.objectContaining({ cache: 'no-store' })),
    );
  });
});
