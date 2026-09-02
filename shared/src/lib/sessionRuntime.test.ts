import { describe, expect, it } from 'vitest';
import { selectSessionRuntime } from './sessionRuntime';
import type { RunLiveness } from './runLiveness';

const liveness = (state: RunLiveness['state']): RunLiveness => ({ state, recoveryActions: [], version: 1 });
const base = { sessionId: 's', activeSessionId: 's', appVisibility: 'foreground' as const };

describe('session runtime selector', () => {
  it('keeps running through app background and shows a background badge after switching sessions', () => {
    expect(selectSessionRuntime({ ...base, appVisibility: 'background', sessionStatus: 'running', activeStream: { active: true } }))
      .toMatchObject({ state: 'busy', running: true, showSpinner: true, terminal: false });
    expect(selectSessionRuntime({ ...base, activeSessionId: 'other', appVisibility: 'background', sessionStatus: 'running' }))
      .toMatchObject({ state: 'busy', backgroundRunning: true, showSpinner: false, showRunningBadge: true });
  });

  it.each([
    ['stale', 'stale'],
    ['orphaned', 'orphaned'],
    ['terminal', 'terminal'],
  ] as const)('projects %s explicitly', (wire, expected) => {
    expect(selectSessionRuntime({ ...base, liveness: liveness(wire), activeStream: { active: true } }).state).toBe(expected);
  });

  it('terminal status wins over a late active_stream and reclaims spinner/lease/runtime-unread', () => {
    expect(selectSessionRuntime({ ...base, sessionStatus: 'completed', activeStream: { active: true } })).toMatchObject({
      state: 'terminal', running: false, showSpinner: false, terminal: true,
      reclaim: { spinner: true, streamLease: true, runtimeUnread: true },
    });
  });

  it('keeps waiting interaction explicit and does not conflate it with unread', () => {
    expect(selectSessionRuntime({ ...base, sessionStatus: 'waiting_user' })).toMatchObject({
      state: 'waiting_interaction', running: false, terminal: false,
      reclaim: { runtimeUnread: false },
    });
  });
});
