import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { GovernanceUnavailable } from './GovernanceUnavailable';
import { GovernanceApiError } from '@agent/shared';

describe('治理共享展示层', () => {
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

  it('保留权威错误码与请求 ID，部分写入不提供盲目重试', () => {
    render(<GovernanceUnavailable error={new GovernanceApiError('GOVERNANCE_PARTIAL_CHANGE', 'partial', 500, 'req-1')} onRetry={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('GOVERNANCE_PARTIAL_CHANGE');
    expect(screen.getByRole('alert').textContent).toContain('请求 ID：req-1');
    expect(screen.queryByRole('button', { name: '重试权威判定' })).toBeNull();
  });
});
