import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionAutomationCard } from './SessionAutomationCard';
import type { SessionAutomationSnapshot } from '@/lib/sessionAutomation';

function snapshot(overrides: Partial<SessionAutomationSnapshot> = {}): SessionAutomationSnapshot {
  return {
    automationId: 'automation-1',
    incarnationId: 'incarnation-1',
    kind: 'goal',
    status: 'active',
    phase: 'running',
    projectionVersion: 4,
    controlVersion: 2,
    condition: 'all tests pass',
    budget: { usedTurns: 3, maxTurns: 20, usedTokens: 1200, maxTokens: 250000 },
    nextActionAt: '2026-08-30T08:00:00.000Z',
    ...overrides,
  };
}

describe('SessionAutomationCard controls', () => {
  it('shows status, phase, budget and dispatches controls', () => {
    const onControl = vi.fn();
    render(<SessionAutomationCard snapshot={snapshot()} onControl={onControl} />);

    expect(screen.getByText('Goal')).toBeTruthy();
    expect(screen.getByText('运行中')).toBeTruthy();
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('3/20')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /暂停/ }));
    expect(onControl).toHaveBeenCalledWith({ action: 'pause' });
  });

  it('represents paused plus active run without implying the run was killed', () => {
    render(<SessionAutomationCard snapshot={snapshot({ status: 'paused', currentRunActive: true, willContinue: false })} onControl={vi.fn()} />);
    expect(screen.getByText('当前轮仍在运行 · 不会再续跑')).toBeTruthy();
    expect(screen.getByRole('button', { name: /继续/ })).toBeTruthy();
  });

  it('edits the goal condition through CAS control payload', () => {
    const onControl = vi.fn();
    render(<SessionAutomationCard snapshot={snapshot()} onControl={onControl} />);
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    fireEvent.change(screen.getByLabelText('编辑 Goal 条件'), { target: { value: 'typecheck is clean' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onControl).toHaveBeenCalledWith({ action: 'edit', payload: { condition: 'typecheck is clean' } });
  });
});
