import { describe, expect, it, vi } from 'vitest';
import type { SessionAutomationLifecycleJob } from '../runtime/sessionAutomationStore.js';
import { createLifecycleAdapters } from './sessionAutomationRuntime.js';

function resourceJob(details: Record<string, unknown>): SessionAutomationLifecycleJob {
  return {
    workId: 'work-1', tenantId: 'tenant-1', sessionId: 'root-session', automationId: 'automation-1',
    incarnationId: 'incarnation-1', generation: 2, objectIncarnationId: 'incarnation-1',
    objectGeneration: 1, objectType: 'background_resource', objectId: 'resource-1', action: 'release',
    attemptCount: 1, details,
  };
}

describe('session automation background resource cancellation authority', () => {
  it('cancels only the prepared child run and never falls back to the root execution run', async () => {
    const cancelRun = vi.fn(async () => undefined);
    const adapter = createLifecycleAdapters(cancelRun).background_resource!;
    const missing = await adapter.execute(resourceJob({
      resource_kind: 'child_run', run_id: 'root-run-must-not-be-cancelled', state: 'prepared',
    }));
    expect(missing).toMatchObject({ outcome: 'pending', payload: { error: 'resource_provider_id_unavailable' } });
    expect(cancelRun).not.toHaveBeenCalled();

    const completed = await adapter.execute(resourceJob({
      resource_kind: 'child_run', run_id: 'root-run-must-not-be-cancelled',
      provider_resource_id: 'prepared-child-run', state: 'prepared',
    }));
    expect(completed).toMatchObject({ outcome: 'completed', payload: { runId: 'prepared-child-run' } });
    expect(cancelRun).toHaveBeenCalledOnce();
    expect(cancelRun).toHaveBeenCalledWith(
      'prepared-child-run', 'session_automation_background_resource_release',
    );
  });
});

describe('session automation provider and billing lifecycle authority', () => {
  it('closes a provider attempt only from the durable attribution authority', async () => {
    const job = { ...resourceJob({ state: 'result_unknown' }), objectType: 'provider_attempt' as const, objectId: 'provider-1', action: 'reconcile' as const };
    const attribution = { readProviderAuthority: vi.fn(async () => ({ state: 'completed' as const, resultPayload: { evaluation: { decision: 'met' } } })) };
    const receipt = await createLifecycleAdapters(vi.fn(), attribution as never).provider_attempt!.execute(job);
    expect(receipt).toMatchObject({ outcome: 'completed', payload: { providerState: 'completed', sideEffectKnown: true } });
    expect(attribution.readProviderAuthority).toHaveBeenCalledWith(expect.objectContaining({ providerAttemptId: 'provider-1', generation: 1 }));
  });

  it('preserves completed provider authority during terminal cancel drain', async () => {
    const job = { ...resourceJob({ state: 'completed' }), objectType: 'provider_attempt' as const, objectId: 'provider-1', action: 'cancel' as const };
    const attribution = { readProviderAuthority: vi.fn(async () => ({ state: 'completed' as const, resultPayload: { evaluation: { decision: 'met' } } })) };
    const receipt = await createLifecycleAdapters(vi.fn(), attribution as never).provider_attempt!.execute(job);
    expect(receipt).toMatchObject({ outcome: 'completed', payload: { providerState: 'completed', sideEffectKnown: true } });
  });

  it('uses suspense rather than release when provider side effect is known but cost is unknown', async () => {
    const job = { ...resourceJob({ state: 'result_unknown', provider_state: 'completed', safe_to_release: false }), objectType: 'budget_reservation' as const, objectId: 'reservation-1', action: 'release' as const };
    const receipt = await createLifecycleAdapters(vi.fn()).budget_reservation!.execute(job);
    expect(receipt).toMatchObject({ outcome: 'completed', payload: { billingClosure: 'suspense', costKnown: false, providerState: 'completed' } });
  });
});
