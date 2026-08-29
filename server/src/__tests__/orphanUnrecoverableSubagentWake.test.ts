import { describe, expect, it, vi } from 'vitest';

import { orphanUnrecoverableSubagentWake } from '../runtime/subagent/orphanUnrecoverableSubagentWake.js';
import type { RunRecord, RunStatus, RunStore } from '../runtime/runStore.js';
import type { SessionCatalog } from '../runtime/sessionCatalog.js';
import { MemoryEventStore } from './runtimeWake.testHelpers.js';

describe('orphanUnrecoverableSubagentWake', () => {
  it('closes the hidden session after the durable run becomes orphaned', async () => {
    let record: RunRecord = {
      runId: 'run-child-1',
      sessionId: 'sub-00000000-0000-4000-8000-000000000001',
      tenantId: 'kaiyan',
      status: 'running',
      requestedAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z',
      metadata: { subagent: true },
    };
    const runStore = {
      get: vi.fn(async () => record),
      markStatusIfCurrent: vi.fn(
        async (
          _runId: string,
          expected: readonly RunStatus[],
          status: RunStatus,
          reason?: string,
          metadataPatch: Record<string, unknown> = {},
        ) => {
          if (!expected.includes(record.status)) return null;
          record = {
            ...record,
            status,
            statusReason: reason,
            metadata: { ...record.metadata, ...metadataPatch },
          };
          return record;
        },
      ),
    } as unknown as RunStore;
    const markStatus = vi.fn(async () => undefined);
    const sessionCatalog = { markStatus } as unknown as SessionCatalog;
    const release = vi.fn(async () => undefined);

    await orphanUnrecoverableSubagentWake({
      runStore,
      eventStore: new MemoryEventStore(),
      sessionCatalog,
      lease: { runId: record.runId, renew: async () => undefined, release },
      sessionId: record.sessionId,
      runId: record.runId,
      tenantId: record.tenantId!,
    });

    expect(release).toHaveBeenCalledWith('orphaned', 'subagent_run_not_recoverable');
    expect(record.status).toBe('orphaned');
    expect(markStatus).toHaveBeenCalledWith(record.sessionId, 'error');
  });
});
