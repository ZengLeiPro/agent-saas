import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GuardrailBoardView } from './GuardrailBoardView';
import type { QaGuardrailBoard } from './types';

const mocks = vi.hoisted(() => ({
  board: {
    total: 0,
    offTopicCount: 0,
    passFlaggedCount: 0,
    topRejections: [],
    modelBreakdown: [],
    fallbackHitRate: 0,
    latency: { p50: null, p90: null, p99: null, samples: 0 },
    dailyCounts: [],
  } as QaGuardrailBoard,
  appeals: [] as Array<{ status: 'pending' | 'accepted' | 'rejected' }>,
}));

vi.mock('./hooks', () => ({
  useQaGuardrailBoard: () => ({
    board: mocks.board,
    loading: false,
    error: null,
    availability: 'available',
    truncated: false,
    refresh: vi.fn(),
  }),
  useQaAppeals: () => ({
    items: mocks.appeals,
    loading: false,
    error: null,
    availability: 'available',
    handle: vi.fn(),
  }),
}));

function kpi(label: string): HTMLElement {
  const labelElement = screen.getByText(label);
  const card = labelElement.parentElement;
  if (!card) throw new Error(`找不到 ${label} KPI 卡片`);
  return card;
}

describe('GuardrailBoardView 样本语义', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/tenant-admin/governance/qa');
    mocks.board = {
      total: 0,
      offTopicCount: 0,
      passFlaggedCount: 0,
      topRejections: [],
      modelBreakdown: [],
      fallbackHitRate: 0,
      latency: { p50: null, p90: null, p99: null, samples: 0 },
      dailyCounts: [],
    };
    mocks.appeals = [];
  });

  it('零样本率显示横线和无样本，不把空日志解释为全部合规', () => {
    render(<GuardrailBoardView orgAgents={[]} />);

    for (const label of ['拒答率', '申诉率', 'fail-open 率']) {
      expect(kpi(label).textContent).toContain('-');
      expect(kpi(label).textContent).toContain('无样本');
      expect(kpi(label).textContent).not.toContain('0%');
    }
    expect(screen.getByText('当前范围暂无门禁日志数据')).toBeTruthy();
  });

  it('有样本时保持原有比率和口径提示', () => {
    mocks.board = {
      total: 4,
      offTopicCount: 1,
      passFlaggedCount: 3,
      topRejections: [{
        bucket: '越界请求',
        count: 1,
        sampleTexts: ['样例'],
        offTopic: 1,
        passFlagged: 0,
      }],
      modelBreakdown: [{ model: 'primary', count: 3, ratio: 0.75 }],
      fallbackHitRate: 0,
      latency: { p50: 100, p90: 200, p99: 300, samples: 4 },
      dailyCounts: [],
    };
    mocks.appeals = [{ status: 'pending' }];

    render(<GuardrailBoardView orgAgents={[]} />);

    expect(kpi('拒答率').textContent).toContain('25.0%');
    expect(kpi('拒答率').textContent).toContain('off_topic 1 / total 4');
    expect(kpi('申诉率').textContent).toContain('100.0%');
    expect(kpi('fail-open 率').textContent).toContain('25.0%');
  });
});
