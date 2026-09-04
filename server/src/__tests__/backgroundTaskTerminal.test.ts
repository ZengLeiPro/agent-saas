import { describe, expect, it } from 'vitest';

import { markBackgroundTaskTerminal } from '../runtime/background/backgroundTaskTerminal.js';
import { readTerminalEventOutbox, retryPendingTerminalEvents } from '../runtime/runTerminalCoordinator.js';
import type { RunRecord } from '../runtime/runStore.js';
import type { PlatformEventInput } from '../runtime/types.js';
import { MemoryRunStore } from './runtimeScheduler.testHelpers.js';
import { MemoryEventStore } from './runtimeWake.testHelpers.js';

const TENANT_ID = 'background-terminal-tenant';

function fixture() {
  const now = new Date().toISOString();
  const run: RunRecord = {
    runId: 'bg-1', sessionId: 'bg-session-1', tenantId: TENANT_ID,
    status: 'running', requestedAt: now, updatedAt: now, metadata: { backgroundTask: true },
  };
  const runStore = new MemoryRunStore();
  runStore.records.set(run.runId, run);
  return { run, runStore };
}

class FailFirstAppendStore extends MemoryEventStore {
  failed = false;
  override async append(event: PlatformEventInput, ctx?: Parameters<MemoryEventStore['append']>[1]) {
    if (!this.failed && event.type === 'run_state_changed') {
      this.failed = true;
      throw new Error('append unavailable');
    }
    return super.append(event, ctx!);
  }
}

describe('background task durable terminal coordination', () => {
  it('only transitions pending/running and never overwrites a concurrent cancellation', async () => {
    const { run, runStore } = fixture();
    await runStore.markStatus(run.runId, 'cancelled', 'user_cancelled');
    const eventStore = new MemoryEventStore();

    await expect(markBackgroundTaskTerminal(
      runStore, eventStore, run, 'completed', undefined,
      { backgroundResult: { status: 'completed' } },
    )).resolves.toBeNull();
    expect(await runStore.get(run.runId)).toMatchObject({ status: 'cancelled' });
    expect(eventStore.events).toHaveLength(0);
  });

  it('persists a failed outbox before returning from append failure and recovers once', async () => {
    const { run, runStore } = fixture();
    const eventStore = new FailFirstAppendStore();

    await expect(markBackgroundTaskTerminal(
      runStore, eventStore, run, 'failed', 'background_failed',
      { backgroundResult: { status: 'failed' }, wakeState: 'pending' },
    )).resolves.toMatchObject({ status: 'failed' });
    expect(readTerminalEventOutbox(await runStore.get(run.runId))).toMatchObject({ state: 'failed' });

    await expect(retryPendingTerminalEvents({
      runStore, eventStore, runId: run.runId, ctx: { tenantId: TENANT_ID },
    })).resolves.toBe(true);
    expect(eventStore.events.filter((event) => event.type === 'run_state_changed')).toHaveLength(1);
    expect(readTerminalEventOutbox(await runStore.get(run.runId))).toMatchObject({ state: 'delivered' });
  });
});
