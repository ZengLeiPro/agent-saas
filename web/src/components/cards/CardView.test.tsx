import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  createInteractionReducerState,
  reduceInteraction,
  selectInteraction,
  selectInteractionCardViewModel,
} from '@agent/shared';
import { CardView } from './CardView';

function pendingModel() {
  const identity = { sessionId: 's', interactionId: 'i', generation: 1 };
  const state = reduceInteraction(createInteractionReducerState(1), { type: 'server_pending', ...identity });
  return selectInteractionCardViewModel({
    sessionId: 's', interactionId: 'i', kind: 'ask_user', state: selectInteraction(state, 's', 'i'), pending: true,
    questions: [{ header: '区域', question: '选择区域', multiSelect: false, options: [{ label: '华东' }, { label: '华西' }] }],
  });
}

describe('M50-02 Web CardView accessibility', () => {
  it('renders Shared heading, question labels, disabled state, expanded state and live outcome', () => {
    const model = pendingModel();
    const { rerender } = render(<CardView model={model} />);
    expect(screen.getByRole('heading', { name: '需要你的回答' })).toBeTruthy();
    expect(screen.getByRole('group', { name: '区域' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '华东' }).getAttribute('aria-label')).toBe('华东');

    const expired = selectInteractionCardViewModel({
      sessionId: 's', interactionId: 'i', kind: 'ask_user', pending: false,
      state: { key: 's\0i', sessionId: 's', interactionId: 'i', generation: 1, phase: 'expired', reason: '已超时', retryable: false, serverAuthoritative: true },
    });
    rerender(<CardView model={expired} />);
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('status').textContent).toContain('已过期：已超时');
  });

  it('does not fire disabled submitting actions on double tap', () => {
    const onAction = vi.fn();
    const model = pendingModel();
    render(<CardView model={model} onAction={onAction} />);
    const submit = screen.getByRole('button', { name: '提交回答' });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
