import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EffectiveResourceView } from '@agent/shared/types/governance';

import { MyPermissionList } from './MyPermissionList';

function resource(
  id: string,
  displayName: string,
  code: EffectiveResourceView['primaryResult']['code'],
  domain: EffectiveResourceView['resource']['domain'] = 'skill',
): EffectiveResourceView {
  return {
    resource: { type: domain, id, tenantId: 'tenant-a', displayName, domain },
    lifecycle: { state: 'published', blocksNewUse: false },
    access: {
      decisionId: `decision-${id}`,
      verdict: code === 'available' ? 'allow' : 'deny',
      accessState: code === 'available' ? 'allowed' : 'denied',
      action: 'use',
      subject: { subjectId: 'user-1', tenantId: 'tenant-a', persona: 'member', isOwner: false },
      resource: { type: domain, id, tenantId: 'tenant-a', displayName, domain },
      decisiveLayer: 'entitlement',
      reasonCode: code === 'available' ? 'ENTITLEMENT_ACTIVE' : 'RESOURCE_NOT_ENTITLED',
      reason: code === 'available' ? '组织权益有效' : 'resource not entitled',
      chain: [],
      policySnapshot: { membershipVersion: 1 },
      nextActions: [],
      evaluatedAt: '2026-09-09T00:00:00.000Z',
    },
    primaryResult: { code, label: code === 'available' ? '可用' : '不可用' },
    decisiveFactor: { code: 'test', label: 'internal detail' },
  };
}

describe('MyPermissionList', () => {
  it('只展示已经生效的权限，不泄露不可用资源和治理原因', () => {
    render(
      <MyPermissionList
        resources={[
          resource('skill-available', '文档处理', 'available'),
          resource('personal_secret_id', 'personal_secret_id', 'unavailable'),
        ]}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('文档处理')).toBeTruthy();
    expect(screen.getByText('可使用')).toBeTruthy();
    expect(screen.queryByText('personal_secret_id')).toBeNull();
    expect(screen.queryByText('resource not entitled')).toBeNull();
    expect(screen.queryByText('internal detail')).toBeNull();
  });

  it('接口异常只显示统一失败态', () => {
    render(
      <MyPermissionList
        resources={null}
        loading={false}
        error={new Error('private backend detail')}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('暂时无法加载我的权限');
    expect(screen.getByRole('alert').textContent).not.toContain('private backend detail');
  });

  it('没有有效权限时显示简洁空态', () => {
    render(
      <MyPermissionList
        resources={[resource('denied', '不可用技能', 'unavailable')]}
        loading={false}
        error={null}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('当前没有可展示的有效权限。')).toBeTruthy();
    expect(screen.queryByText('不可用技能')).toBeNull();
  });
});
