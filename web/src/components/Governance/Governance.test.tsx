import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EffectiveResourceList } from './EffectiveResourceList';
import { GovernanceUnavailable } from './GovernanceUnavailable';
import { PermissionWhyPanel } from './PermissionWhyPanel';
import { governanceFixture } from './testFixtures';

describe('治理共享展示层', () => {
  it('Access allow 但 Readiness not ready 时分轴展示，不把允许误写成可执行', () => {
    const evaluation = governanceFixture({
      ready: false,
      primaryResult: 'not_ready',
      primaryLabel: '允许访问，但执行未就绪',
    });
    const { container } = render(<PermissionWhyPanel evaluation={evaluation} />);

    expect(screen.getByRole('heading', { name: '允许访问，但执行未就绪' })).toBeTruthy();
    expect(screen.getByText('访问：allowed')).toBeTruthy();
    expect(screen.getAllByText('未就绪').length).toBeGreaterThan(0);
    expect(screen.getByText(/连接凭据已过期/)).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(8); // 7-layer chain + blocker
    expect(container.textContent).not.toContain('subject-secret-id');
    expect(container.textContent).not.toContain('credential-secret-id');
    expect(container.textContent).not.toContain('provider-secret-id');
  });

  it('deny 每行只展示服务端主结果、决定因素和第一个合法 next action', () => {
    const onAction = vi.fn();
    const denied = governanceFixture({
      accessState: 'denied',
      primaryResult: 'unavailable',
      primaryLabel: '无权访问',
      decisiveLabel: '租户策略拒绝',
      actions: [
        { code: 'contact_admin', label: '联系管理员' },
        { code: 'view_reason', label: '查看原因' },
      ],
    });
    render(<EffectiveResourceList resources={[denied]} onAction={onAction} />);

    expect(screen.getByText('无权访问')).toBeTruthy();
    expect(screen.getByText('租户策略拒绝')).toBeTruthy();
    screen.getByRole('button', { name: '联系管理员' }).click();
    expect(onAction).toHaveBeenCalledWith(denied.access.nextActions[0], denied);
    expect(screen.queryByText('查看原因')).toBeNull();
  });

  it('needs authorization 只使用服务端提供的授权动作和站内 href', () => {
    render(<EffectiveResourceList resources={[governanceFixture({
      domain: 'connector',
      accessState: 'needs_user_authorization',
      primaryResult: 'needs_authorization',
      primaryLabel: '需要用户授权',
      actions: [{ code: 'authorize', label: '去授权', href: '/settings/connectors' }],
    })]} />);

    expect(screen.getByRole('heading', { name: '连接器' })).toBeTruthy();
    expect(screen.getByText('需要用户授权')).toBeTruthy();
    expect(screen.getByRole('link', { name: '去授权' }).getAttribute('href')).toBe('/settings/connectors');
  });

  it('503 错误明确标记服务不可用，绝不误报账号缺权', () => {
    render(<GovernanceUnavailable error={Object.assign(new Error('private backend detail'), { status: 503 })} onRetry={vi.fn()} />);

    expect(screen.getByRole('alert').textContent).toContain('权限服务暂不可用');
    expect(screen.getByRole('alert').textContent).toContain('不代表当前账号缺少权限');
    expect(screen.getByRole('alert').textContent).toContain('服务状态：503');
    expect(screen.getByRole('alert').textContent).not.toContain('private backend detail');
  });

  it('只有明确 403 才显示权限不足', () => {
    render(<GovernanceUnavailable error={Object.assign(new Error('forbidden'), { status: 403 })} />);

    expect(screen.getByRole('alert').textContent).toContain('权限不足');
    expect(screen.getByRole('alert').textContent).toContain('当前账号没有访问此治理页面的权限');
    expect(screen.getByRole('alert').textContent).not.toContain('权限服务暂不可用');
  });
});
