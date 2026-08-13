import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GuardrailEventsView } from './GuardrailEventsView';

vi.mock('./hooks', () => ({
  useQaGuardrailEvents: () => ({
    events: [],
    total: 0,
    offset: 0,
    limit: 20,
    loading: false,
    error: null,
    availability: 'available',
    refresh: vi.fn(),
    nextPage: vi.fn(),
    prevPage: vi.fn(),
  }),
}));

describe('GuardrailEventsView 空数据语义', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/tenant-admin/governance/qa');
  });

  it('零记录时与 Board 一致表达为无数据，不推断成员提问都在服务范围内', () => {
    render(<GuardrailEventsView orgAgents={[]} />);

    expect(screen.getByText('当前范围暂无门禁日志数据')).toBeTruthy();
    expect(screen.getByText('当前没有可用于判断服务范围表现的门禁记录。')).toBeTruthy();
    expect(screen.queryByText(/都在专家的服务范围内/)).toBeNull();
    expect(screen.queryByText('期间没有触发门禁')).toBeNull();
  });
});
