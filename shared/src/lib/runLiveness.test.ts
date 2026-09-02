import { describe, expect, it } from 'vitest';
import {
  createRunLivenessProjectionState,
  mergeRunLiveness,
  normalizeRunLiveness,
  reduceRunLivenessProjection,
  selectProjectedRunLiveness,
  selectRunLivenessPresentation,
  selectRunLivenessRecovery,
  type RunLiveness,
  type RunLivenessState,
} from './runLiveness';

const live = (
  state: Exclude<RunLivenessState, 'unknown'>,
  patch: Partial<RunLiveness> = {},
): RunLiveness => ({ state, recoveryActions: state === 'terminal' ? [] : ['cancel'], version: 1, ...patch });

describe('RunLiveness protocol', () => {
  it.each([
    ['active', '仍在运行', true, false],
    ['busy', '仍在运行', true, false],
    ['waiting_interaction', '等待操作', false, false],
    ['stale', '连接中断/正在确认', false, false],
    ['orphaned', '需要重试或取消', false, true],
    ['terminal', '完成/失败', false, true],
  ] as const)('maps %s without local timeout inference', (state, label, running, terminal) => {
    expect(selectRunLivenessPresentation(live(state))).toMatchObject({ state, label, running, terminal });
  });

  it.each([undefined, null, {}, { state: 'busy' }, { state: 'busy', version: 0, recoveryActions: [] }])(
    'degrades legacy/malformed %j to unknown',
    (input) => expect(normalizeRunLiveness(input)).toEqual({ state: 'unknown', recoveryActions: [], version: 0 }),
  );

  it.each(['terminal', 'stale', 'orphaned'] as const)(
    'keeps %s sticky against a late busy frame',
    (state) => expect(mergeRunLiveness(live(state), live('busy')).state).toBe(state),
  );

  it('allows only forward sticky convergence stale → orphaned → terminal', () => {
    expect(mergeRunLiveness(live('stale'), live('orphaned')).state).toBe('orphaned');
    expect(mergeRunLiveness(live('orphaned'), live('terminal')).state).toBe('terminal');
  });

  it('fences generation, epoch, session and run identities', () => {
    let state = createRunLivenessProjectionState(2, 'epoch-2');
    state = reduceRunLivenessProjection(state, { type: 'observe', generation: 1, epoch: 'epoch-2', sessionId: 's', runId: 'r', liveness: live('busy') });
    state = reduceRunLivenessProjection(state, { type: 'observe', generation: 2, epoch: 'epoch-1', sessionId: 's', runId: 'r', liveness: live('busy') });
    expect(selectProjectedRunLiveness(state, 's', 'r').state).toBe('unknown');
    state = reduceRunLivenessProjection(state, { type: 'observe', generation: 2, epoch: 'epoch-2', sessionId: 's', runId: 'r', liveness: live('stale') });
    state = reduceRunLivenessProjection(state, { type: 'observe', generation: 2, epoch: 'epoch-2', sessionId: 'other', runId: 'r', liveness: live('busy') });
    expect(selectProjectedRunLiveness(state, 's', 'r').state).toBe('stale');
    expect(selectProjectedRunLiveness(state, 'other', 'r').state).toBe('busy');
  });

  it('intersects recovery with server allow-list and offline/lock/fence gates', () => {
    const orphaned = live('orphaned', { recoveryActions: ['retry', 'cancel'] });
    expect(selectRunLivenessRecovery(orphaned, { online: true, locallyUnlocked: true })).toMatchObject({ actions: ['retry', 'cancel'], canRetry: true, canCancel: true });
    expect(selectRunLivenessRecovery(orphaned, { online: false, locallyUnlocked: true })).toMatchObject({ actions: [], blockedReason: 'offline' });
    expect(selectRunLivenessRecovery(orphaned, { online: true, locallyUnlocked: false })).toMatchObject({ actions: [], blockedReason: 'locked' });
    expect(selectRunLivenessRecovery(orphaned, { online: true, locallyUnlocked: true, epochFenceCurrent: false })).toMatchObject({ actions: [], blockedReason: 'stale_fence' });
  });

  it('requires manual inspection and removes retry for unknown external tool outcome', () => {
    const uncertain = live('orphaned', { reasonCode: 'external_tool_outcome_unknown', recoveryActions: ['retry', 'cancel'] });
    expect(selectRunLivenessRecovery(uncertain, { online: true, locallyUnlocked: true })).toMatchObject({
      actions: ['cancel'], canRetry: false, canCancel: true, manualInspectionRequired: true,
    });
  });
});
