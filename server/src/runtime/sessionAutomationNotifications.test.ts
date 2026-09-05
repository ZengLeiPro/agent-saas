import { describe, expect, it, vi } from 'vitest';
import type { SessionAutomationSnapshot } from '@agent/shared';
import { PgSessionAutomationStore } from './sessionAutomationStore.js';

const base: SessionAutomationSnapshot = {
  automationId: 'automation', incarnationId: 'incarnation', tenantId: 'tenant', sessionId: 'session',
  ownerUserId: 'owner', status: 'active', phase: 'idle', generation: 1, specVersion: 1,
  controlVersion: 1, projectionVersion: 1, continuationEpoch: 1,
  spec: { kind: 'loop', mode: 'adaptive', prompt: 'work', budget: {} }, runCount: 1,
  noProgressCount: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('session automation Web notifications', () => {
  it.each([
    [{ status: 'completed' }, 'automation_completed'],
    [{ status: 'blocked' }, 'automation_blocked'],
    [{ status: 'expired', lastError: 'max_tokens' }, 'automation_budget_limited'],
    [{ status: 'expired', lastError: 'expires_at' }, 'automation_expired'],
    [{ status: 'reconcile_required' }, 'automation_reconcile_required'],
    [{ status: 'paused', lastError: 'no_progress' }, 'automation_no_progress'],
    [{ status: 'failed', lastError: 'dispatch_dead' }, 'automation_consecutive_failure'],
  ] as const)('publishes state and %s notification', (patch, code) => {
    const notifier = vi.fn();
    const store = new PgSessionAutomationStore({} as never);
    store.setNotifier(notifier);
    store.publish({ ...base, ...patch } as SessionAutomationSnapshot);
    expect(notifier).toHaveBeenNthCalledWith(1, 'owner', expect.objectContaining({ type: 'automation_state_changed' }));
    expect(notifier).toHaveBeenNthCalledWith(2, 'owner', expect.objectContaining({ type: 'automation_notification', code }));
  });
});
