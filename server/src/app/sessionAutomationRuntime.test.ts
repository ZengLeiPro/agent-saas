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
