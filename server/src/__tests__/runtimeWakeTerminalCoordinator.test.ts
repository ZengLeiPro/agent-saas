import { describe, expect, it, vi } from 'vitest';

import { wakeRuntimeSession, type RawRuntimeRunDispatchConfig, type RuntimeWakeLease } from '../runtime/rawRuntimeRunDispatch.js';
import { readTerminalEventOutbox, retryPendingTerminalEvents } from '../runtime/runTerminalCoordinator.js';
import type { RunRecord, RunStatus } from '../runtime/runStore.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import type { PlatformEventInput } from '../runtime/types.js';
import { MemoryRunStore } from './runtimeScheduler.testHelpers.js';
import { MemoryEventStore, MemorySessionCatalog } from './runtimeWake.testHelpers.js';

const TENANT_ID = 'terminal-wake-tenant';

function fixture(status: RunStatus = 'running', metadata: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const session: RuntimeSessionRecord = {
    sessionId: 'session-terminal', userId: 'user-1', username: 'alice', tenantId: TENANT_ID,
    channel: 'web', cwd: '/tmp/alice', transcriptPath: '/tmp/alice/session.jsonl',
    modelRef: 'gpt-5.4-mini', executionTarget: 'server-local', workspaceId: 'workspace-1',
    status: 'running', createdAt: now, updatedAt: now,
  };
  const run: RunRecord = {
    runId: 'run-terminal', sessionId: session.sessionId, userId: session.userId, tenantId: TENANT_ID,
    status, model: session.modelRef, channel: 'web', requestedAt: now, updatedAt: now,
    executionTarget: session.executionTarget, workspaceId: session.workspaceId, metadata,
  };
  const runStore = new MemoryRunStore();
  runStore.records.set(run.runId, run);
  const releases: Array<{ status?: RunStatus; reason?: string }> = [];
  const lease: RuntimeWakeLease = {
    runId: run.runId, renew: async () => undefined,
    release: async (releaseStatus, reason) => { releases.push({ status: releaseStatus, reason }); },
  };
  return { session, run, runStore, releases, lease };
}

function configFor(
  session: RuntimeSessionRecord,
  runStore: MemoryRunStore,
  eventStore: MemoryEventStore,
): RawRuntimeRunDispatchConfig {
  return {
    agentCwd: '/tmp', sharedDir: '/tmp', runStore,
    sessionCatalog: new MemorySessionCatalog(session), eventStoreFactory: () => eventStore,
  };
}

class FailFirstTerminalAppendStore extends MemoryEventStore {
  failed = false;
  override async append(event: PlatformEventInput, ctx?: Parameters<MemoryEventStore['append']>[1]) {
    if (!this.failed && event.type === 'run_state_changed') {
      this.failed = true;
      throw new Error('terminal append unavailable');
    }
    return super.append(event, ctx!);
  }
}

describe('wakeRuntimeSession durable terminal coordination', () => {
  it('retains an append failure in the outbox, retries it, and does not duplicate terminal projection', async () => {
    const { session, run, runStore, releases, lease } = fixture();
    const eventStore = new FailFirstTerminalAppendStore();
    await eventStore.append({
      type: 'run_cancel_requested', sessionId: run.sessionId, runId: run.runId, reason: 'cancel',
    }, { tenantId: TENANT_ID });
    const config = configFor(session, runStore, eventStore);

    await wakeRuntimeSession(config, run, { lease });
    expect(await runStore.get(run.runId)).toMatchObject({ status: 'cancelled' });
    expect(readTerminalEventOutbox(await runStore.get(run.runId))).toMatchObject({ state: 'failed' });
    expect(releases).toEqual([{ status: undefined, reason: 'cancel_requested_before_wake' }]);

    await expect(retryPendingTerminalEvents({
      runStore, eventStore, runId: run.runId, ctx: { tenantId: TENANT_ID },
    })).resolves.toBe(true);
    await wakeRuntimeSession(config, run, { lease });

    expect(eventStore.events.filter((event) => event.type === 'run_state_changed')).toHaveLength(1);
    expect(readTerminalEventOutbox(await runStore.get(run.runId))).toMatchObject({ state: 'delivered' });
  });

  it.each([
    ['approval missing command', { resumeApproval: { approvalId: 'approval-1', response: { allow: true } } }, 'failed', 'missing_interaction_resolved_command'],
    ['interaction missing command', { resumeInteraction: { interactionId: 'ask-1', response: { answers: {} } } }, 'failed', 'missing_interaction_resolved_command'],
  ] as const)('terminalizes %s through the durable coordinator', async (_name, metadata, expectedStatus, reason) => {
    const { session, run, runStore, releases, lease } = fixture('running', metadata);
    const eventStore = new MemoryEventStore();

    await wakeRuntimeSession(configFor(session, runStore, eventStore), run, { lease });

    expect(await runStore.get(run.runId)).toMatchObject({ status: expectedStatus, statusReason: reason });
    expect(readTerminalEventOutbox(await runStore.get(run.runId))).toMatchObject({ state: 'delivered' });
    expect(eventStore.events.at(-1)).toMatchObject({ type: 'run_state_changed', status: expectedStatus, reason });
    expect(releases).toEqual([{ status: undefined, reason }]);
  });

  it('repairs a completed state-only approval wake exactly once', async () => {
    const metadata = { resumeApproval: { approvalId: 'approval-1', response: { allow: true } } };
    const { session, run, runStore, lease } = fixture('completed', metadata);
    const eventStore = new MemoryEventStore();
    await eventStore.append({
      type: 'approval_resolved', sessionId: run.sessionId, runId: run.runId,
      approvalId: 'approval-1', decision: 'approved',
    }, { tenantId: TENANT_ID });
    const config = configFor(session, runStore, eventStore);

    await wakeRuntimeSession(config, run, { lease });
    await wakeRuntimeSession(config, run, { lease });

    expect(eventStore.events.filter((event) => event.type === 'run_state_changed')).toHaveLength(1);
    expect(eventStore.events.at(-1)).toMatchObject({ type: 'run_state_changed', status: 'completed' });
    expect(readTerminalEventOutbox(await runStore.get(run.runId))).toMatchObject({ state: 'delivered' });
  });

  it('publishes orphaned before releasing an unrecoverable subagent lease', async () => {
    const { session, run, runStore, lease } = fixture();
    session.kind = 'subagent';
    const eventStore = new MemoryEventStore();
    const order: string[] = [];
    const append = eventStore.append.bind(eventStore);
    eventStore.append = vi.fn(async (event, ctx) => {
      if (event.type === 'run_state_changed') order.push('terminal');
      return append(event, ctx);
    });
    lease.release = vi.fn(async () => { order.push('release'); });

    await wakeRuntimeSession(configFor(session, runStore, eventStore), run, { lease });

    expect(order).toEqual(['terminal', 'release']);
    expect(await runStore.get(run.runId)).toMatchObject({ status: 'orphaned' });
    expect(readTerminalEventOutbox(await runStore.get(run.runId))).toMatchObject({ state: 'delivered' });
  });
});
