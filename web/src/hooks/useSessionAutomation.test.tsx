import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  messageHandler: null as ((event: { data: unknown }) => void) | null,
  stateHandler: null as ((state: string) => void) | null,
  authFetch: vi.fn(),
}));

vi.mock('@/lib/authFetch', () => ({ authFetch: mocks.authFetch }));
vi.mock('@/lib/wsClient', () => ({
  wsClient: {
    onMessage: vi.fn((handler: (event: { data: unknown }) => void) => { mocks.messageHandler = handler; return () => { mocks.messageHandler = null; }; }),
    onStateChange: vi.fn((handler: (state: string) => void) => { mocks.stateHandler = handler; return () => { mocks.stateHandler = null; }; }),
  },
}));

import { useSessionAutomationRuntime as useSessionAutomation } from './useSessionAutomationRuntime';

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function automation(projectionVersion: number) {
  return {
    automationId: 'automation-1', incarnationId: 'incarnation-1', kind: 'goal' as const,
    status: 'active', controlVersion: 1, projectionVersion,
  };
}

describe('useSessionAutomation projection', () => {
  beforeEach(() => {
    mocks.authFetch.mockReset();
    mocks.messageHandler = null;
    mocks.stateHandler = null;
    mocks.authFetch.mockImplementation((url: string) => url.includes('/events')
      ? Promise.resolve(response({ events: [], cursor: 'cursor-1' }))
      : Promise.resolve(response({ automation: automation(1), cursor: 'cursor-0' })));
  });

  it('drops lower projectionVersion websocket state', async () => {
    const { result } = renderHook(() => useSessionAutomation({ sessionId: 'session-1' }));
    await waitFor(() => expect(result.current.snapshot?.projectionVersion).toBe(1));

    act(() => mocks.messageHandler?.({ data: { type: 'automation_state_changed', eventId: 'event-5', sessionId: 'session-1', snapshot: automation(5) } }));
    expect(result.current.snapshot?.projectionVersion).toBe(5);
    act(() => mocks.messageHandler?.({ data: { type: 'automation_state_changed', eventId: 'event-4', sessionId: 'session-1', snapshot: automation(4) } }));
    expect(result.current.snapshot?.projectionVersion).toBe(5);
  });

  it('deduplicates notification event ids and refetches snapshot on reconnect', async () => {
    const onNotification = vi.fn();
    renderHook(() => useSessionAutomation({ sessionId: 'session-1', onNotification }));
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalled());

    const event = { data: { type: 'automation_notification', eventId: 'notice-1', sessionId: 'session-1', severity: 'warn', message: 'budget limited' } };
    act(() => { mocks.messageHandler?.(event); mocks.messageHandler?.(event); });
    expect(onNotification).toHaveBeenCalledTimes(1);

    const callsBeforeReconnect = mocks.authFetch.mock.calls.length;
    act(() => mocks.stateHandler?.('connected'));
    await waitFor(() => expect(mocks.authFetch.mock.calls.length).toBeGreaterThan(callsBeforeReconnect));
  });
});
