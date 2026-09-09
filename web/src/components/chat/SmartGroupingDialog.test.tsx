import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ generate: vi.fn(), apply: vi.fn() }));
vi.mock('@agent/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/shared')>()),
  generateSmartGroupingPlan: api.generate,
  applySmartGroupingPlan: api.apply,
}));

import { SmartGroupingButton } from './SmartGroupingDialog';

describe('SmartGroupingDialog', () => {
  beforeEach(() => {
    api.generate.mockReset();
    api.apply.mockReset();
  });

  it('先展示只读方案，确认后才应用', async () => {
    const onApplied = vi.fn();
    api.generate.mockResolvedValue({
      scope: 'ungrouped',
      fingerprint: 'fingerprint',
      truncated: false,
      groups: [{ name: '客户项目', sessionIds: ['s1'] }],
      ungroupedSessionIds: [],
      sessions: [{ sessionId: 's1', title: '客户甲报价' }],
    });
    api.apply.mockResolvedValue(undefined);
    render(<SmartGroupingButton onApplied={onApplied} />);

    fireEvent.click(screen.getByRole('button', { name: '智能分组' }));
    fireEvent.click(screen.getByRole('button', { name: '生成分组方案' }));
    expect(await screen.findByText('客户项目')).toBeTruthy();
    expect(screen.getByText('客户甲报价')).toBeTruthy();
    expect(api.apply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '确认应用' }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1));
    expect(onApplied).toHaveBeenCalledTimes(1);
  });
});
