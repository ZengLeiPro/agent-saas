import { describe, expect, it } from 'vitest';
import type { RunLiveness } from '@agent/shared';
import { adaptWebRunLiveness } from './runLivenessAdapter';

const dto = (state: RunLiveness['state'], patch: Partial<RunLiveness> = {}): RunLiveness => ({
  state, version: 1, recoveryActions: state === 'orphaned' ? ['retry', 'cancel'] : [], ...patch,
});

describe('Web run liveness adapter', () => {
  it.each([
    ['active', '仍在运行', 'active'], ['busy', '仍在运行', 'active'],
    ['waiting_interaction', '等待操作', 'neutral'], ['stale', '连接中断/正在确认', 'warning'],
    ['orphaned', '需要重试或取消', 'danger'], ['terminal', '完成/失败', 'terminal'],
  ] as const)('presents server %s as %s', (state, label, tone) => {
    expect(adaptWebRunLiveness(dto(state), { online: true, locallyUnlocked: true })).toMatchObject({ label, tone });
  });

  it('fails closed for N-1 and never invents recovery while offline/locked', () => {
    expect(adaptWebRunLiveness(undefined, { online: true, locallyUnlocked: true })).toMatchObject({ state: 'unknown', label: '状态待确认', recovery: { actions: [] } });
    expect(adaptWebRunLiveness(dto('orphaned'), { online: false, locallyUnlocked: true }).recovery.actions).toEqual([]);
    expect(adaptWebRunLiveness(dto('orphaned'), { online: true, locallyUnlocked: false }).recovery.actions).toEqual([]);
  });

  it('never retries an uncertain external tool outcome', () => {
    const view = adaptWebRunLiveness(dto('orphaned', { reasonCode: 'external_tool_outcome_unknown' }), { online: true, locallyUnlocked: true });
    expect(view.recovery).toMatchObject({ actions: ['cancel'], canRetry: false, manualInspectionRequired: true });
  });
});
