import type pg from 'pg';

import type { PlatformEvent } from './types.js';

export function pgEventGlobalSequenceLockKey(eventsTable: string): string {
  return `${eventsTable}:global-sequence-commit-order`;
}

export async function lockPgEventGlobalSequence(
  client: pg.PoolClient,
  eventsTable: string,
): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
    pgEventGlobalSequenceLockKey(eventsTable),
  ]);
}

export interface PgEventNotifyRangePayload {
  v: 1;
  type: 'event_range';
  sessionId: string;
  afterCursor: string;
  fromCursor: string;
  toCursor: string;
  count: number;
}

export type PgEventNotifyDecodedPayload =
  | {
    kind: 'range';
    sessionId: string;
    afterCursor: string;
    fromCursor: string;
    toCursor: string;
    count: number;
  }
  | { kind: 'eventId'; eventId: string };

export function parsePgCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function encodePgEventNotifyPayload(events: Array<PlatformEvent & { sequence: number }>): string {
  if (events.length === 0) {
    throw new Error('cannot encode empty PgEventStore notification payload');
  }
  const first = events[0]!;
  const last = events[events.length - 1]!;
  if (!first.sessionId) {
    throw new Error('cannot encode PgEventStore notification payload without sessionId');
  }
  return JSON.stringify({
    v: 1,
    type: 'event_range',
    sessionId: first.sessionId,
    afterCursor: String(first.sequence - 1),
    fromCursor: String(first.sequence),
    toCursor: String(last.sequence),
    count: events.length,
  } satisfies PgEventNotifyRangePayload);
}

export function decodePgEventNotifyPayload(payload: string): PgEventNotifyDecodedPayload {
  try {
    const parsed = JSON.parse(payload) as Partial<PgEventNotifyRangePayload>;
    if (
      parsed
      && parsed.v === 1
      && parsed.type === 'event_range'
      && typeof parsed.sessionId === 'string'
      && parsed.sessionId.length > 0
      && typeof parsed.afterCursor === 'string'
      && typeof parsed.fromCursor === 'string'
      && typeof parsed.toCursor === 'string'
      && typeof parsed.count === 'number'
      && Number.isInteger(parsed.count)
      && parsed.count > 0
      && isPositiveCursor(parsed.fromCursor)
      && isPositiveCursor(parsed.toCursor)
      && parsePgCursor(parsed.toCursor) >= parsePgCursor(parsed.fromCursor)
      && parsed.count === parsePgCursor(parsed.toCursor) - parsePgCursor(parsed.fromCursor) + 1
    ) {
      return {
        kind: 'range',
        sessionId: parsed.sessionId,
        afterCursor: parsed.afterCursor,
        fromCursor: parsed.fromCursor,
        toCursor: parsed.toCursor,
        count: parsed.count,
      };
    }
  } catch {
    // Legacy payloads are raw event ids, not JSON.
  }
  return { kind: 'eventId', eventId: payload };
}

function isPositiveCursor(value: string): boolean {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 && String(parsed) === value;
}
