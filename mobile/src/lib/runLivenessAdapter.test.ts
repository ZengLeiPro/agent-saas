import { describe, expect, it } from 'vitest';
import type { RunLiveness } from '@agent/shared';
import { adaptMobileRunLiveness } from './runLivenessAdapter';

const dto = (state: RunLiveness['state'], patch: Partial<RunLiveness> = {}): RunLiveness => ({
  state, version: 1, recoveryActions: state === 'orphaned' ? ['retry', 'cancel'] : [], ...patch,
});

describe('Mobile run liveness adapter', () => {
  it.each([
    ['active', '仍在运行', 'progress'], ['busy', '仍在运行', 'progress'],
    ['waiting_interaction', '等待操作', 'muted'], ['stale', '连接中断/正在确认', 'attention'],
    ['orphaned', '需要重试或取消', 'critical'], ['terminal', '完成/失败', 'settled'],
  ] as const)('presents server %s without a local timer', (state, label, emphasis) => {
    expect(adaptMobileRunLiveness(dto(state), { online: true, locallyUnlocked: true })).toMatchObject({ label, accessibilityLabel: label, emphasis });
  });

  it('keeps recovery behind online, app-lock and identity/session fences', () => {
    const orphaned = dto('orphaned');
    expect(adaptMobileRunLiveness(orphaned, { online: false, locallyUnlocked: true }).recovery).toMatchObject({ actions: [], blockedReason: 'offline' });
    expect(adaptMobileRunLiveness(orphaned, { online: true, locallyUnlocked: false }).recovery).toMatchObject({ actions: [], blockedReason: 'locked' });
    expect(adaptMobileRunLiveness(orphaned, { online: true, locallyUnlocked: true, identityFenceCurrent: false }).recovery).toMatchObject({ actions: [], blockedReason: 'stale_fence' });
    expect(adaptMobileRunLiveness(orphaned, { online: true, locallyUnlocked: true, sessionFenceCurrent: false }).recovery).toMatchObject({ actions: [], blockedReason: 'stale_fence' });
  });

  it('allows manual inspection/cancel but never retry for unknown external outcome', () => {
    const view = adaptMobileRunLiveness(dto('orphaned', { reasonCode: 'external_tool_outcome_unknown' }), { online: true, locallyUnlocked: true });
    expect(view.recovery).toMatchObject({ actions: ['cancel'], canRetry: false, canCancel: true, manualInspectionRequired: true });
  });
});
