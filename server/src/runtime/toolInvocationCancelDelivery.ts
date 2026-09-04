import { randomUUID } from 'node:crypto';

import type { HandRecord, HandStore } from './handStore.js';
import type { RunStore } from './runStore.js';
import type { ToolInvocationRecord, ToolInvocationStore } from './toolInvocationStore.js';
import type { PlatformEvent } from './types.js';

type CancelEvent = Extract<PlatformEvent, { type: 'tool_invocation_cancel_requested' }>;

export interface ToolInvocationCancelDeliveryOptions {
  toolInvocationStore?: ToolInvocationStore;
  handStore?: HandStore;
  runStore?: RunStore;
  serverRemoteBaseUrl?: string;
  serverRemoteAuthToken?: string;
  resolveHandAuthToken?: (hand: HandRecord) => string | undefined | Promise<string | undefined>;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  deliveryWorkerId?: string;
  deliveryLeaseMs?: number;
  deliveryRequestTimeoutMs?: number;
  now?: Date;
  fetchImpl?: typeof fetch;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

export interface DeliverToolInvocationCancelInput extends ToolInvocationCancelDeliveryOptions {
  event: CancelEvent;
}

export interface CancelDeliveryResult {
  status:
    | 'delivered'
    | 'not_found_assumed_terminal'
    | 'run_abort_only'
    | 'missing_auth_token'
    | 'ownership_mismatch'
    | 'already_claimed'
    | 'retry_scheduled'
    | 'dead_letter'
    | 'missing_record';
  record?: ToolInvocationRecord;
}

export async function deliverToolInvocationCancel(input: DeliverToolInvocationCancelInput): Promise<CancelDeliveryResult> {
  const record = await input.toolInvocationStore?.requestCancel(
    input.event.invocationId,
    input.event.reason,
    input.event.metadata,
  ).catch((err) => {
    input.logger?.warn?.('requestCancel failed', {
      invocationId: input.event.invocationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (!record) return { status: 'missing_record' };
  return deliverToolInvocationCancelRecord({
    ...input,
    record,
    eventMetadata: input.event.metadata,
  });
}

export async function deliverPendingToolInvocationCancels(
  input: ToolInvocationCancelDeliveryOptions,
): Promise<{ scanned: number; attempted: number; results: Record<string, number> }> {
  const records = await input.toolInvocationStore?.listCancelRequested().catch((err) => {
    input.logger?.warn?.('listCancelRequested failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }) ?? [];
  const now = input.now ?? new Date();
  const results: Record<string, number> = {};
  let attempted = 0;
  for (const record of records) {
    const nextAttemptAt = parseOptionalDate(record.metadata.cancelDeliveryNextAttemptAt);
    if (nextAttemptAt && nextAttemptAt.getTime() > now.getTime()) continue;
    attempted += 1;
    const result = await deliverToolInvocationCancelRecord({ ...input, record });
    results[result.status] = (results[result.status] ?? 0) + 1;
  }
  return { scanned: records.length, attempted, results };
}

async function deliverToolInvocationCancelRecord(input: ToolInvocationCancelDeliveryOptions & {
  record: ToolInvocationRecord;
  eventMetadata?: Record<string, unknown>;
}): Promise<CancelDeliveryResult> {
  const store = input.toolInvocationStore;
  const wallStartedAt = Date.now();
  const now = input.now ?? new Date();
  const claimId = `${input.deliveryWorkerId ?? `pid-${process.pid}`}:${randomUUID()}`;
  const deliveryLeaseMs = input.deliveryLeaseMs ?? 30_000;
  // 先完成无外部副作用的归属/端点/凭据解析，claim 从真正投递前才开始计时。
  // 否则慢查询会消耗 lease，DELETE 尚在途时第二个 scanner 就可能重新取得 claim。
  const metadata = { ...input.record.metadata, ...(input.eventMetadata ?? {}) };
  const run = await input.runStore?.get(input.record.runId).catch(() => null);
  const ownerWorkerId = typeof metadata.workerId === 'string' ? metadata.workerId : undefined;
  const handId = typeof metadata.handId === 'string'
    ? metadata.handId
    : typeof metadata.defaultHandId === 'string'
      ? metadata.defaultHandId
      : undefined;
  const hand = handId && run?.tenantId
    ? await input.handStore?.get(handId, run.tenantId).catch(() => null)
    : null;
  const endpoint = resolveEndpoint(input.record, metadata, hand, input);
  const authToken = await resolveAuthToken(metadata, hand, input);
  const claimedRecord = await store?.claimCancelDelivery(
    input.record.invocationId,
    claimId,
    deliveryLeaseMs,
    input.now ? new Date(input.now.getTime() + (Date.now() - wallStartedAt)) : new Date(),
  ).catch((err) => {
    input.logger?.warn?.('claimCancelDelivery failed', {
      invocationId: input.record.invocationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  if (!claimedRecord) return { status: 'already_claimed', record: input.record };
  input = { ...input, record: claimedRecord };

  if (
    run?.status === 'running'
    && run.workerId
    && ownerWorkerId
    && run.workerId !== ownerWorkerId
  ) {
    const patch = buildAttemptMetadata(input.record, now, 'worker_ownership_mismatch', {
      cancelDeliveryOwnerWorkerId: ownerWorkerId,
      cancelDeliveryCurrentWorkerId: run.workerId,
    }, input);
    const terminal = patch.cancelDelivery === 'dead_letter';
    const finalized = await markAttempt(store, input.record.invocationId, patch, terminal, claimId);
    return finalized
      ? { status: terminal ? 'dead_letter' : 'ownership_mismatch', record: input.record }
      : { status: 'already_claimed', record: input.record };
  }

  if (!endpoint) {
    const finalized = await store?.markCancelDelivered(input.record.invocationId, {
      cancelDelivery: 'run_abort_only',
      cancelDeliveryTerminal: true,
      cancelDeliveryReason: 'missing_hand_endpoint',
      ...(handId ? { handId } : {}),
    }, claimId).catch(() => null);
    return finalized
      ? { status: 'run_abort_only', record: input.record }
      : { status: 'already_claimed', record: input.record };
  }

  if (!authToken) {
    const finalized = await store?.markCancelDelivered(input.record.invocationId, {
      cancelDelivery: 'missing_auth_token',
      cancelDeliveryTerminal: true,
      ...(handId ? { handId } : {}),
      handEndpoint: endpoint,
      ...(hand?.metadata.authTokenRef ? { authTokenRef: hand.metadata.authTokenRef } : {}),
    }, claimId).catch(() => null);
    return finalized
      ? { status: 'missing_auth_token', record: input.record }
      : { status: 'already_claimed', record: input.record };
  }

  const attemptMetadata = baseAttemptMetadata(input.record, now, {
    ...(handId ? { handId } : {}),
    handEndpoint: endpoint,
    ...(hand ? { handStatus: hand.status } : {}),
  });
  const claimExpiresAt = parseOptionalDate(input.record.metadata.cancelDeliveryClaimExpiresAt);
  const remainingLeaseMs = claimExpiresAt
    ? claimExpiresAt.getTime() - Date.now()
    : deliveryLeaseMs;
  const requestTimeoutMs = Math.min(
    input.deliveryRequestTimeoutMs ?? 20_000,
    Math.max(1, remainingLeaseMs - 1_000),
  );
  try {
    const response = await (input.fetchImpl ?? fetch)(`${endpoint.replace(/\/$/, '')}/invocations/${encodeURIComponent(input.record.invocationId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    let responseBody: unknown;
    try {
      responseBody = await response.clone().json();
    } catch {
      responseBody = undefined;
    }

    if (response.ok) {
      const cancelled = responseBody && typeof responseBody === 'object' && 'cancelled' in responseBody
        ? Boolean((responseBody as { cancelled?: unknown }).cancelled)
        : undefined;
      const claimedButNotRegistered = cancelled === false
        && input.record.status === 'running'
        && typeof input.record.metadata.invokeClaimedAt === 'string';
      if (claimedButNotRegistered) {
        const patch = buildAttemptMetadata(input.record, now, 'not_found_before_start', {
          ...attemptMetadata,
          cancelDeliveryStatus: response.status,
          cancelDeliveryCancelled: false,
        }, input);
        const terminal = patch.cancelDelivery === 'dead_letter';
        const finalized = await markAttempt(store, input.record.invocationId, patch, terminal, claimId);
        return finalized
          ? { status: terminal ? 'dead_letter' : 'retry_scheduled', record: input.record }
          : { status: 'already_claimed', record: input.record };
      }
      const delivery = cancelled === false ? 'not_found_assumed_terminal' : 'delivered';
      const finalized = await store?.markCancelDelivered(input.record.invocationId, {
        ...attemptMetadata,
        cancelDelivery: delivery,
        cancelDeliveryTerminal: true,
        cancelDeliveryStatus: response.status,
        ...(typeof cancelled === 'boolean' ? { cancelDeliveryCancelled: cancelled } : {}),
      }, claimId).catch(() => null);
      return finalized
        ? { status: delivery, record: input.record }
        : { status: 'already_claimed', record: input.record };
    }

    const patch = buildAttemptMetadata(input.record, now, 'http_error', {
      ...attemptMetadata,
      cancelDeliveryStatus: response.status,
    }, input);
    const terminal = patch.cancelDelivery === 'dead_letter';
    const finalized = await markAttempt(store, input.record.invocationId, patch, terminal, claimId);
    return finalized
      ? { status: terminal ? 'dead_letter' : 'retry_scheduled', record: input.record }
      : { status: 'already_claimed', record: input.record };
  } catch (err) {
    input.logger?.warn?.('hand-aware cancel delivery failed', {
      invocationId: input.record.invocationId,
      endpoint,
      error: err instanceof Error ? err.message : String(err),
    });
    const patch = buildAttemptMetadata(input.record, now, 'network_error', {
      ...attemptMetadata,
      cancelDeliveryError: err instanceof Error ? err.message : String(err),
    }, input);
    const terminal = patch.cancelDelivery === 'dead_letter';
    const finalized = await markAttempt(store, input.record.invocationId, patch, terminal, claimId);
    return finalized
      ? { status: terminal ? 'dead_letter' : 'retry_scheduled', record: input.record }
      : { status: 'already_claimed', record: input.record };
  }
}

async function markAttempt(
  store: ToolInvocationStore | undefined,
  invocationId: string,
  metadata: Record<string, unknown>,
  terminal: boolean,
  claimId: string,
): Promise<boolean> {
  if (terminal) {
    const record = await store?.markCancelDelivered(invocationId, metadata, claimId).catch(() => null);
    return Boolean(record);
  }
  const record = await store?.markCancelDeliveryAttempt(invocationId, metadata, claimId).catch(() => null);
  return Boolean(record);
}

function baseAttemptMetadata(
  record: ToolInvocationRecord,
  now: Date,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const attempts = getAttemptCount(record) + 1;
  return {
    ...extra,
    cancelDeliveryAttempts: attempts,
    cancelDeliveryLastAttemptAt: now.toISOString(),
  };
}

function buildAttemptMetadata(
  record: ToolInvocationRecord,
  now: Date,
  reason: string,
  extra: Record<string, unknown>,
  options: ToolInvocationCancelDeliveryOptions,
): Record<string, unknown> {
  const attempts = getAttemptCount(record) + 1;
  const maxAttempts = options.maxAttempts ?? 3;
  if (attempts >= maxAttempts) {
    return {
      ...extra,
      cancelDelivery: 'dead_letter',
      cancelDeliveryTerminal: true,
      cancelDeliveryDeadLetterAt: now.toISOString(),
      cancelDeliveryAttempts: attempts,
      cancelDeliveryLastAttemptAt: now.toISOString(),
      cancelDeliveryLastReason: reason,
    };
  }
  const retryMs = Math.min(
    options.retryMaxMs ?? 30_000,
    (options.retryBaseMs ?? 500) * 2 ** Math.max(0, attempts - 1),
  );
  return {
    ...extra,
    cancelDelivery: 'retry_scheduled',
    cancelDeliveryTerminal: false,
    cancelDeliveryAttempts: attempts,
    cancelDeliveryLastAttemptAt: now.toISOString(),
    cancelDeliveryLastReason: reason,
    cancelDeliveryNextAttemptAt: new Date(now.getTime() + retryMs).toISOString(),
  };
}

function getAttemptCount(record: ToolInvocationRecord): number {
  const attempts = record.metadata.cancelDeliveryAttempts;
  return typeof attempts === 'number' && Number.isFinite(attempts) && attempts >= 0 ? attempts : 0;
}

function resolveEndpoint(
  record: ToolInvocationRecord,
  metadata: Record<string, unknown>,
  hand: HandRecord | null | undefined,
  input: ToolInvocationCancelDeliveryOptions,
): string | undefined {
  if (typeof metadata.handEndpoint === 'string' && metadata.handEndpoint.trim()) return metadata.handEndpoint.trim();
  if (hand?.endpoint) return hand.endpoint;
  if (record.executionTarget === 'server-remote' && input.serverRemoteBaseUrl) return input.serverRemoteBaseUrl;
  return undefined;
}

async function resolveAuthToken(
  metadata: Record<string, unknown>,
  hand: HandRecord | null | undefined,
  input: ToolInvocationCancelDeliveryOptions,
): Promise<string | undefined> {
  const selectedHandId = metadata.handId ?? metadata.defaultHandId;
  if (typeof selectedHandId === 'string' && selectedHandId.trim() && !hand) return undefined;
  const tenantHand = typeof hand?.metadata.tenantRemoteHandId === 'string'
    && hand.metadata.tenantRemoteHandId.trim().length > 0;
  if (tenantHand) {
    const resolved = await input.resolveHandAuthToken?.(hand);
    return typeof resolved === 'string' && resolved.trim() ? resolved.trim() : undefined;
  }
  const explicit = metadata.cancelAuthToken ?? metadata.authToken;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  if (hand && input.resolveHandAuthToken) {
    const resolved = await input.resolveHandAuthToken(hand);
    if (typeof resolved === 'string' && resolved.trim()) return resolved.trim();
  }
  const handToken = hand?.metadata.cancelAuthToken ?? hand?.metadata.authToken ?? hand?.metadata.serverRemoteAuthToken;
  if (typeof handToken === 'string' && handToken.trim()) return handToken.trim();
  return input.serverRemoteAuthToken;
}

function parseOptionalDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}
