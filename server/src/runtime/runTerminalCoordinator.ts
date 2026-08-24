import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { runtimeRunController } from './runController.js';
import type { RunRecord, RunStatus, RunStore } from './runStore.js';
import type { TerminalEventOutboxRunStore } from './runTerminalOutboxStore.js';
import type { EventStore, PlatformEvent, PlatformEventInput } from './types.js';
import { isTerminalRunStatus } from './wakeDispatchHelpers.js';

const NON_TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'pending',
  'running',
  'waiting_approval',
  'waiting_user',
  'waiting_hand',
];

export const TERMINAL_EVENT_OUTBOX_METADATA_KEY = 'terminalEventOutbox';

type TerminalDeliveryState = 'pending' | 'failed' | 'delivering' | 'delivered';

export interface TerminalEventOutboxRecord {
  version: 1;
  deliveryId: string;
  /** Tenant captured with the durable payload. Missing only on legacy rows awaiting recovery. */
  tenantId?: string;
  state: TerminalDeliveryState;
  terminalStatus: Extract<RunStatus, 'completed' | 'failed' | 'cancelled' | 'orphaned'>;
  events: PlatformEventInput[];
  attempts: number;
  updatedAt: string;
  lastError?: string;
  /** Non-retryable fail-closed diagnostic for missing/mismatched authoritative tenancy. */
  tenantResolutionError?: string;
  nextAttemptAt?: string;
  claimToken?: string;
  claimedAt?: string;
}

export interface TerminalEventLogger {
  warn(message: string): void;
}

export class TerminalRunCasLostError extends Error {
  constructor(
    readonly runId: string,
    readonly requestedStatus: RunStatus,
    readonly actualStatus?: RunStatus,
  ) {
    super(`run terminal CAS lost: run=${runId} requested=${requestedStatus} actual=${actualStatus ?? 'unknown'}`);
    this.name = 'TerminalRunCasLostError';
  }
}

export class TerminalOutboxTenantResolutionError extends Error {
  constructor(readonly runId: string, detail: string) {
    super(`terminal outbox tenant resolution failed: run=${runId} ${detail}`);
    this.name = 'TerminalOutboxTenantResolutionError';
  }
}

function normalizedTenantId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function resolveTerminalTenantId(input: {
  runId: string;
  runTenantId?: string;
  outboxTenantId?: string;
  contextTenantId?: string;
}): string {
  const runTenantId = normalizedTenantId(input.runTenantId);
  const outboxTenantId = normalizedTenantId(input.outboxTenantId);
  const contextTenantId = normalizedTenantId(input.contextTenantId);
  const authoritativeTenantId = runTenantId ?? contextTenantId;
  if (!authoritativeTenantId) {
    throw new TerminalOutboxTenantResolutionError(input.runId, 'authoritative runtime run/session tenant is missing');
  }
  if (runTenantId && contextTenantId && runTenantId !== contextTenantId) {
    throw new TerminalOutboxTenantResolutionError(
      input.runId,
      `runtime run tenant=${runTenantId} does not match session context tenant=${contextTenantId}`,
    );
  }
  if (outboxTenantId && outboxTenantId !== authoritativeTenantId) {
    throw new TerminalOutboxTenantResolutionError(
      input.runId,
      `durable tenant=${outboxTenantId} does not match authoritative tenant=${authoritativeTenantId}`,
    );
  }
  return authoritativeTenantId;
}

function requireTerminalAppendContext(
  runId: string,
  ctx?: Parameters<EventStore['append']>[1],
): Parameters<EventStore['append']>[1] {
  const tenantId = normalizedTenantId(ctx?.tenantId);
  if (!tenantId) throw new TerminalOutboxTenantResolutionError(runId, 'append tenant context is missing');
  return { tenantId };
}

export async function appendRunStateChanged(
  eventStore: EventStore,
  sessionId: string,
  runId: string,
  status: RunStatus,
  previousStatus?: RunStatus,
  reason?: string,
  ctx?: Parameters<EventStore['append']>[1],
): Promise<PlatformEvent> {
  return eventStore.append({
    type: 'run_state_changed',
    runId,
    sessionId,
    status,
    ...(previousStatus ? { previousStatus } : {}),
    ...(reason ? { reason } : {}),
  }, requireTerminalAppendContext(runId, ctx));
}

export async function persistRunStatus(
  runStore: RunStore,
  runId: string,
  status: RunStatus,
  reason?: string,
  metadataPatch?: Record<string, unknown>,
): Promise<RunRecord | null> {
  if (isTerminalRunStatus(status) && runStore.markStatusIfCurrent) {
    return runStore.markStatusIfCurrent(
      runId,
      NON_TERMINAL_RUN_STATUSES,
      status,
      reason,
      metadataPatch,
    );
  }
  return runStore.markStatus(runId, status, reason, metadataPatch);
}

function terminalOutbox(
  status: RunStatus,
  events: PlatformEventInput[],
  tenantId: string,
): TerminalEventOutboxRecord {
  if (!isTerminalRunStatus(status)) throw new Error(`terminal outbox requires terminal status: ${status}`);
  const deliveryId = randomUUID();
  const claimToken = randomUUID();
  const now = new Date().toISOString();
  return {
    version: 1,
    deliveryId,
    tenantId,
    state: 'delivering',
    terminalStatus: status as TerminalEventOutboxRecord['terminalStatus'],
    // Persist a stable marker with every event. After append succeeds but the
    // outbox acknowledgement is lost, recovery can observe these markers and
    // acknowledge instead of publishing a duplicate batch.
    events: events.map((event, index) => ({
      ...event,
      terminalDeliveryId: deliveryId,
      terminalDeliveryIndex: index,
    })) as PlatformEventInput[],
    attempts: 0,
    updatedAt: now,
    claimToken,
    claimedAt: now,
  };
}

function outboxPatch(outbox: TerminalEventOutboxRecord): Record<string, unknown> {
  return { [TERMINAL_EVENT_OUTBOX_METADATA_KEY]: outbox };
}

function durableOutboxStore(runStore: RunStore): TerminalEventOutboxRunStore | null {
  const candidate = runStore as Partial<TerminalEventOutboxRunStore>;
  return candidate.claimTerminalEventOutbox && candidate.finishTerminalEventOutbox
    && candidate.listPendingTerminalEventOutboxes ? candidate as TerminalEventOutboxRunStore : null;
}

function warnTerminalDelivery(logger: TerminalEventLogger | undefined, message: string): void {
  logger?.warn(message);
}

function terminalRetryAt(attempts: number, now = Date.now()): string {
  const delayMs = Math.min(30_000, 500 * (2 ** Math.min(Math.max(0, attempts - 1), 6)));
  return new Date(now + delayMs).toISOString();
}

async function patchOutboxBestEffort(
  runStore: RunStore,
  runId: string,
  outbox: TerminalEventOutboxRecord,
  logger?: TerminalEventLogger,
): Promise<void> {
  if (!runStore.patchMetadata) return;
  try {
    await runStore.patchMetadata(runId, outboxPatch(outbox));
  } catch (error) {
    warnTerminalDelivery(
      logger,
      `[run-terminal] outbox metadata patch failed run=${runId} delivery=${outbox.deliveryId}: ${errorMessage(error)}`,
    );
  }
}

async function finishClaimedOutboxBestEffort(
  runStore: RunStore,
  runId: string,
  previous: TerminalEventOutboxRecord,
  next: TerminalEventOutboxRecord,
  logger?: TerminalEventLogger,
): Promise<void> {
  const durableStore = durableOutboxStore(runStore);
  if (durableStore && previous.claimToken) {
    try {
      await durableStore.finishTerminalEventOutbox(
        runId,
        previous.deliveryId,
        previous.claimToken,
        next as unknown as Record<string, unknown>,
      );
      return;
    } catch (error) {
      warnTerminalDelivery(
        logger,
        `[run-terminal] outbox claim finish failed run=${runId} delivery=${previous.deliveryId}: ${errorMessage(error)}`,
      );
      return;
    }
  }
  await patchOutboxBestEffort(runStore, runId, next, logger);
}

async function appendTerminalEvents(
  eventStore: EventStore,
  events: PlatformEventInput[],
  ctx: Parameters<EventStore['append']>[1],
): Promise<PlatformEvent[]> {
  if (events.length > 1 && eventStore.appendBatch) return eventStore.appendBatch(events, ctx);
  const stored: PlatformEvent[] = [];
  for (const event of events) stored.push(await eventStore.append(event, ctx));
  return stored;
}

async function terminalEventsAlreadyAppended(
  eventStore: EventStore,
  outbox: TerminalEventOutboxRecord,
): Promise<boolean> {
  if (!eventStore.listByRun || outbox.events.length === 0) return false;
  const first = outbox.events[0];
  if (!first || typeof first.sessionId !== 'string' || !('runId' in first) || typeof first.runId !== 'string') return false;
  const tenantId = normalizedTenantId(outbox.tenantId);
  if (!tenantId) throw new TerminalOutboxTenantResolutionError(first.runId, 'durable terminal tenant is missing');
  const existing = await eventStore.listByRun(tenantId, first.sessionId, first.runId);
  const indexes = new Set(existing.flatMap((event) => {
    const marked = event as PlatformEvent & { terminalDeliveryId?: string; terminalDeliveryIndex?: number };
    return marked.terminalDeliveryId === outbox.deliveryId && Number.isInteger(marked.terminalDeliveryIndex)
      ? [marked.terminalDeliveryIndex!]
      : [];
  }));
  if (outbox.events.every((_event, index) => indexes.has(index))) return true;
  // Backward compatibility for outboxes persisted before delivery markers were
  // introduced: terminal CAS permits only one semantic terminal batch per run.
  return outbox.events.every((expected) => existing.some((actual) => (
    expected.type === actual.type
    && Object.entries(expected).every(([key, value]) => (
      key === 'terminalDeliveryId' || key === 'terminalDeliveryIndex'
      || isDeepStrictEqual((actual as unknown as Record<string, unknown>)[key], value)
    ))
  )));
}

export interface FinalizeTerminalRunResult {
  won: boolean;
  record: RunRecord | null;
  storedEvents: PlatformEvent[];
  deliveryError?: Error;
  outbox?: TerminalEventOutboxRecord;
}

/**
 * Claims a terminal state in runtime_runs before publishing any terminal event.
 * The outbox payload is committed in the same CAS, so an append failure remains
 * durably discoverable and can be replayed with retryPendingTerminalEvents().
 */
export async function finalizeTerminalRun(input: {
  runStore: RunStore;
  eventStore: EventStore;
  runId: string;
  status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled' | 'orphaned'>;
  reason?: string;
  events: PlatformEventInput[];
  expectedStatuses?: readonly RunStatus[];
  ctx?: Parameters<EventStore['append']>[1];
  logger?: TerminalEventLogger;
  onClaim?: () => void;
}): Promise<FinalizeTerminalRunResult> {
  const current = await input.runStore.get(input.runId);
  const tenantId = resolveTerminalTenantId({
    runId: input.runId,
    runTenantId: current?.tenantId,
    contextTenantId: input.ctx?.tenantId,
  });
  const outbox = terminalOutbox(input.status, input.events, tenantId);
  const appendContext = { ...(input.ctx ?? {}), tenantId };
  const expectedStatuses = input.expectedStatuses ?? NON_TERMINAL_RUN_STATUSES;

  // Production PgRunStore implements this as one UPDATE ... WHERE status=ANY(...).
  // The guarded markStatus fallback exists only for lightweight/file test stores.
  const updated = input.runStore.markStatusIfCurrent
    ? await input.runStore.markStatusIfCurrent(
        input.runId,
        expectedStatuses,
        input.status,
        input.reason,
        outboxPatch(outbox),
      )
    : await claimWithGuardedFallback(input.runStore, input.runId, expectedStatuses, input.status, input.reason, outbox);

  if (!updated) {
    return {
      won: false,
      record: await input.runStore.get(input.runId),
      storedEvents: [],
    };
  }

  // Abort immediately after the durable timeout CAS. Event publication and its
  // retries must never extend the lifetime of a billable model/tool execution.
  input.onClaim?.();

  try {
    const storedEvents = await appendTerminalEvents(input.eventStore, input.events, appendContext);
    const delivered: TerminalEventOutboxRecord = {
      ...outbox,
      state: 'delivered',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      nextAttemptAt: undefined,
      lastError: undefined,
      claimToken: undefined,
      claimedAt: undefined,
    };
    await finishClaimedOutboxBestEffort(input.runStore, input.runId, outbox, delivered, input.logger);
    return { won: true, record: updated, storedEvents, outbox: delivered };
  } catch (error) {
    const deliveryError = toError(error);
    const failed: TerminalEventOutboxRecord = {
      ...outbox,
      state: 'failed',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      nextAttemptAt: terminalRetryAt(1),
      lastError: deliveryError.message,
      claimToken: undefined,
      claimedAt: undefined,
    };
    await finishClaimedOutboxBestEffort(input.runStore, input.runId, outbox, failed, input.logger);
    warnTerminalDelivery(
      input.logger,
      `[run-terminal] event append failed; durable outbox retained run=${input.runId} delivery=${outbox.deliveryId}: ${deliveryError.message}`,
    );
    return { won: true, record: updated, storedEvents: [], deliveryError, outbox: failed };
  }
}

async function claimWithGuardedFallback(
  runStore: RunStore,
  runId: string,
  expectedStatuses: readonly RunStatus[],
  status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled' | 'orphaned'>,
  reason: string | undefined,
  outbox: TerminalEventOutboxRecord,
): Promise<RunRecord | null> {
  const current = await runStore.get(runId);
  if (!current || !expectedStatuses.includes(current.status)) return null;
  const updated = await runStore.markStatus(runId, status, reason, outboxPatch(outbox));
  if (updated?.status !== status) return null;
  const claimedOutbox = readTerminalEventOutbox(updated);
  return claimedOutbox?.deliveryId === outbox.deliveryId ? updated : null;
}

export async function coordinateRunFinishedEvent(input: {
  runStore: RunStore;
  eventStore: EventStore;
  event: Extract<PlatformEventInput, { type: 'run_finished' }>;
  ctx?: Parameters<EventStore['append']>[1];
  logger?: TerminalEventLogger;
}): Promise<PlatformEvent> {
  const status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'> = input.event.subtype === 'success'
    ? 'completed'
    : input.event.subtype === 'interrupted'
      ? 'cancelled'
      : 'failed';
  const reason = input.event.subtype === 'error'
    ? input.event.error ?? input.event.subtype
    : input.event.subtype === 'interrupted'
      ? input.event.subtype
      : undefined;
  const before = await input.runStore.get(input.event.runId);
  const stateEvent: Extract<PlatformEventInput, { type: 'run_state_changed' }> = {
    type: 'run_state_changed',
    runId: input.event.runId,
    sessionId: input.event.sessionId,
    status,
    ...(before?.status ? { previousStatus: before.status } : {}),
    ...(reason ? { reason } : {}),
    ...(input.event.failureKind ? { failureKind: input.event.failureKind } : {}),
    ...(input.event.recoveryAction ? { recoveryAction: input.event.recoveryAction } : {}),
  };
  const result = await finalizeTerminalRun({
    runStore: input.runStore,
    eventStore: input.eventStore,
    runId: input.event.runId,
    status,
    reason,
    events: [input.event, stateEvent],
    ctx: input.ctx,
    logger: input.logger,
  });
  if (!result.won) {
    throw new TerminalRunCasLostError(input.event.runId, status, result.record?.status);
  }
  // A durable outbox owns retry after append failure. Project only the winning
  // state while delivery is pending; never synthesize a conflicting run_finished.
  return result.storedEvents[0] ?? {
    id: `terminal-outbox-${result.outbox?.deliveryId ?? input.event.runId}`,
    timestamp: new Date().toISOString(),
    ...stateEvent,
  };
}

export async function trackRunStateAfterEvent(input: {
  runStore: RunStore | undefined;
  eventStore: EventStore;
  event: PlatformEvent;
  ctx?: Parameters<EventStore['append']>[1];
}): Promise<void> {
  if (!input.runStore || input.event.type === 'run_state_changed' || input.event.type === 'run_finished') return;
  let status: RunStatus | undefined;
  let reason: string | undefined;
  const event = input.event;
  if (event.type === 'approval_requested') {
    status = 'waiting_approval';
    reason = `approval:${event.approvalId}`;
  } else if (event.type === 'approval_resolved') {
    status = 'running';
    reason = `approval_resolved:${event.approvalId}`;
  } else if (event.type === 'interaction_requested' && event.interactionType === 'ask_user') {
    status = 'waiting_user';
    reason = `interaction:${event.interactionId}`;
  } else if (event.type === 'interaction_resolved' && event.interactionType === 'ask_user') {
    status = 'running';
    reason = `interaction_resolved:${event.interactionId}`;
  }
  if (!status || !('runId' in event) || typeof event.runId !== 'string' || typeof event.sessionId !== 'string') return;
  const before = await input.runStore.get(event.runId);
  if (isTerminalRunStatus(before?.status)) return;
  const updated = await input.runStore.markStatus(event.runId, status, reason);
  if (!updated || updated.status !== status) return;
  await appendRunStateChanged(
    input.eventStore,
    event.sessionId,
    event.runId,
    status,
    before?.status,
    reason,
    { tenantId: resolveTerminalTenantId({
      runId: event.runId,
      runTenantId: before?.tenantId,
      contextTenantId: input.ctx?.tenantId,
    }) },
  );
}

/** Atomically claims and re-publishes a durable terminal event outbox. */
export async function retryPendingTerminalEvents(input: {
  runStore: RunStore;
  eventStore: EventStore;
  runId: string;
  ctx?: Parameters<EventStore['append']>[1];
  logger?: TerminalEventLogger;
  now?: Date;
  claimTtlMs?: number;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  let run = await input.runStore.get(input.runId);
  let outbox = readTerminalEventOutbox(run);
  if (!run || !outbox || outbox.state === 'delivered' || run.status !== outbox.terminalStatus) return false;

  const durableStore = durableOutboxStore(input.runStore);
  if (durableStore) {
    const claimToken = randomUUID();
    run = await durableStore.claimTerminalEventOutbox(
      input.runId,
      outbox.deliveryId,
      claimToken,
      now,
      new Date(now.getTime() - (input.claimTtlMs ?? 30_000)),
    );
    outbox = readTerminalEventOutbox(run);
    if (!run || !outbox || outbox.claimToken !== claimToken) return false;
  }

  try {
    const tenantId = resolveTerminalTenantId({
      runId: input.runId,
      runTenantId: run.tenantId,
      outboxTenantId: outbox.tenantId,
      contextTenantId: input.ctx?.tenantId,
    });
    outbox = { ...outbox, tenantId, tenantResolutionError: undefined };
    const appendContext = { ...(input.ctx ?? {}), tenantId };
    const alreadyAppended = await terminalEventsAlreadyAppended(input.eventStore, outbox);
    if (!alreadyAppended) await appendTerminalEvents(input.eventStore, outbox.events, appendContext);
    const delivered: TerminalEventOutboxRecord = {
      ...outbox,
      state: 'delivered',
      attempts: outbox.attempts + 1,
      updatedAt: now.toISOString(),
      nextAttemptAt: undefined,
      lastError: undefined,
      tenantResolutionError: undefined,
      claimToken: undefined,
      claimedAt: undefined,
    };
    await finishClaimedOutboxBestEffort(input.runStore, input.runId, outbox, delivered, input.logger);
    return true;
  } catch (error) {
    const deliveryError = toError(error);
    const tenantResolutionFailed = deliveryError instanceof TerminalOutboxTenantResolutionError;
    const attempts = outbox.attempts + 1;
    const failed: TerminalEventOutboxRecord = {
      ...outbox,
      state: 'failed',
      attempts,
      updatedAt: now.toISOString(),
      nextAttemptAt: tenantResolutionFailed ? undefined : terminalRetryAt(attempts, now.getTime()),
      lastError: deliveryError.message,
      tenantResolutionError: tenantResolutionFailed ? deliveryError.message : undefined,
      claimToken: undefined,
      claimedAt: undefined,
    };
    await finishClaimedOutboxBestEffort(input.runStore, input.runId, outbox, failed, input.logger);
    warnTerminalDelivery(
      input.logger,
      `[run-terminal] event replay failed run=${input.runId} delivery=${outbox.deliveryId}: ${deliveryError.message}`,
    );
    return false;
  }
}

export function readTerminalEventOutbox(run: RunRecord | null | undefined): TerminalEventOutboxRecord | null {
  const candidate = run?.metadata?.[TERMINAL_EVENT_OUTBOX_METADATA_KEY];
  if (!candidate || typeof candidate !== 'object') return null;
  const value = candidate as Partial<TerminalEventOutboxRecord>;
  if (
    value.version !== 1
    || typeof value.deliveryId !== 'string'
    || !['pending', 'failed', 'delivering', 'delivered'].includes(String(value.state))
    || !isTerminalRunStatus(value.terminalStatus as RunStatus)
    || !Array.isArray(value.events)
    || typeof value.attempts !== 'number'
    || typeof value.updatedAt !== 'string'
  ) return null;
  return value as TerminalEventOutboxRecord;
}

export async function markRunState(
  runStore: RunStore | undefined,
  eventStore: EventStore,
  sessionId: string,
  runId: string,
  status: RunStatus,
  reason?: string,
  logger?: TerminalEventLogger,
  ctx?: Parameters<EventStore['append']>[1],
): Promise<void> {
  const before = runStore ? await runStore.get(runId) : null;
  const tenantId = resolveTerminalTenantId({
    runId,
    runTenantId: before?.tenantId,
    contextTenantId: ctx?.tenantId,
  });
  const appendContext = { tenantId };
  if (!runStore) {
    await appendRunStateChanged(eventStore, sessionId, runId, status, before?.status, reason, appendContext);
    return;
  }
  if (isTerminalRunStatus(status)) {
    await finalizeTerminalRun({
      runStore,
      eventStore,
      runId,
      status: status as TerminalEventOutboxRecord['terminalStatus'],
      reason,
      events: [{
        type: 'run_state_changed',
        runId,
        sessionId,
        status,
        ...(before?.status ? { previousStatus: before.status } : {}),
        ...(reason ? { reason } : {}),
      }],
      ctx: appendContext,
      logger,
    });
    return;
  }

  const updated = await persistRunStatus(runStore, runId, status, reason);
  // A terminal sink cannot be reactivated by a stale approval/user resume path.
  if (!updated || updated.status !== status) return;
  await appendRunStateChanged(eventStore, sessionId, runId, status, before?.status, reason, appendContext);
}

export async function failRunningRunForWallClock(input: {
  runStore: RunStore | undefined;
  eventStore: EventStore;
  sessionId: string;
  runId: string;
  abortController?: AbortController;
  logger?: TerminalEventLogger;
}): Promise<boolean> {
  const reason = 'run_max_wall_clock_exceeded';
  // Without durable state, running cannot be distinguished from a human wait.
  if (!input.runStore) return false;

  const result = await finalizeTerminalRun({
    runStore: input.runStore,
    eventStore: input.eventStore,
    runId: input.runId,
    status: 'failed',
    reason,
    expectedStatuses: ['running'],
    events: [{
      type: 'run_state_changed',
      runId: input.runId,
      sessionId: input.sessionId,
      status: 'failed',
      previousStatus: 'running',
      reason,
    }],
    logger: input.logger,
    onClaim: () => {
      if (!input.abortController?.signal.aborted) {
        input.abortController?.abort(new Error(reason));
      }
    },
  });
  return result.won;
}

export function armRuntimeRunWallClock(input: {
  runStore: RunStore | undefined;
  eventStore: EventStore;
  sessionId: string;
  runId: string;
  abortController: AbortController;
  logger?: TerminalEventLogger;
}): void {
  runtimeRunController.armWallClock(input.runId, input.abortController, {
    shouldAbort: () => failRunningRunForWallClock(input),
  });
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return toError(error).message;
}
