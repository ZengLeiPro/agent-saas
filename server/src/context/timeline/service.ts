import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ContextSourceAuthorizationRegistry,
  contextSourceLocatorFromRow,
  type ContextSourceAuthorizationDenyReason,
} from '../retrieval/sourceAuthorization.js';
import { contextTableNames, contextTablePrefix, type ContextPgPool } from '../store/index.js';
import type { ContextJson } from '../store/types.js';
import {
  ContextTimelineCursorError,
  type ContextTimelineItem,
  type ContextTimelineRequest,
  type ContextTimelineResult,
} from './types.js';

type Row = Record<string, unknown>;

interface TimelineCursorPayload {
  t: string;
  o: string;
  s: string;
  c: string;
  r: string;
  v: number;
}

export interface ContextTimelineServiceOptions {
  pool: ContextPgPool;
  tablePrefix?: string;
  sourceAuthorizationRegistry?: ContextSourceAuthorizationRegistry;
  cursorSigningKey?: string;
}

const PROCESS_TIMELINE_CURSOR_SIGNING_KEY = randomBytes(32).toString('base64url');

/** Revision-backed timeline with assignment filtering before live native-source ACL. */
export class ContextTimelineService {
  private readonly tables;
  private readonly cursorSigningKey: string;

  constructor(private readonly options: ContextTimelineServiceOptions) {
    this.tables = contextTableNames(contextTablePrefix(options.tablePrefix));
    this.cursorSigningKey = options.cursorSigningKey?.trim() || PROCESS_TIMELINE_CURSOR_SIGNING_KEY;
  }

  async list(request: ContextTimelineRequest): Promise<ContextTimelineResult> {
    throwIfAborted(request.signal);
    const collectionIds = [...new Set(request.scope.collections.map(value => value.collectionId))];
    if (collectionIds.length === 0) return { items: [], degraded: false };
    const limit = Math.max(1, Math.min(100, Math.trunc(request.limit)));
    const cursor = request.cursor ? decodeCursor(request.cursor, this.cursorSigningKey) : null;
    if (request.cursor && (!cursor || cursor.t !== request.subject.tenantId)) throw new ContextTimelineCursorError();

    const occurredAt = `COALESCE(
      v.occurred_at,
      CASE WHEN PG_INPUT_IS_VALID(v.metadata_json->>'occurredAt','timestamp with time zone')
        THEN (v.metadata_json->>'occurredAt')::timestamptz END,
      v.source_updated_at,v.observed_at,v.created_at
    )`;
    const result = await this.options.pool.query(`
      WITH assigned AS (
        SELECT v.tenant_id,v.source_id,v.collection_id,v.record_id,v.revision AS current_revision,
               v.content_json,v.metadata_json,v.deleted,v.revoked,s.kind AS source_kind,
               v.entity_type,v.native_id,current_record.owner_principal,current_record.acl_principals,
               ${occurredAt} AS occurred_at,
               NULLIF(COALESCE(v.source_event_id,v.metadata_json->>'sourceEventId',v.metadata_json->>'source_event_id'),'') AS source_event_id,
               COALESCE(v.record_kind,CASE WHEN v.metadata_json->>'recordType'='event'
                      OR v.metadata_json->>'record_type'='event'
                      OR v.metadata_json->>'kind'='event'
                      OR NULLIF(COALESCE(v.metadata_json->>'eventType',v.metadata_json->>'event_type'),'') IS NOT NULL
                    THEN 'event' ELSE 'snapshot' END) AS record_kind
        FROM ${this.tables.revisions} v
        JOIN ${this.tables.records} current_record
          ON current_record.tenant_id=v.tenant_id AND current_record.source_id=v.source_id
          AND current_record.collection_id=v.collection_id AND current_record.record_id=v.record_id
          AND current_record.deleted=FALSE AND current_record.revoked=FALSE
        JOIN ${this.tables.sources} s
          ON s.tenant_id=v.tenant_id AND s.source_id=v.source_id
        JOIN ${this.tables.collections} c
          ON c.tenant_id=v.tenant_id AND c.source_id=v.source_id AND c.collection_id=v.collection_id
        WHERE v.tenant_id=$1 AND v.collection_id=ANY($2::text[])
          AND s.kind<>'dws'
          AND v.revoked=FALSE AND s.status='active' AND c.status='active'
          AND NOT EXISTS (
            SELECT 1 FROM ${this.tables.partitions} auth_partition
            WHERE auth_partition.tenant_id=v.tenant_id AND auth_partition.source_id=v.source_id
              AND auth_partition.collection_id=v.collection_id
              AND (auth_partition.refused=TRUE OR auth_partition.status='refused')
          )
      ), deduplicated AS (
        SELECT assigned.*,
               ROW_NUMBER() OVER (
                 PARTITION BY COALESCE(source_event_id,source_id||CHR(0)||collection_id||CHR(0)||record_id||CHR(0)||current_revision::text)
                 ORDER BY CASE WHEN record_kind='event' THEN 0 ELSE 1 END,occurred_at DESC,
                          source_id DESC,collection_id DESC,record_id DESC,current_revision DESC
               ) AS source_event_rank
        FROM assigned
        WHERE deleted=FALSE OR record_kind='event'
      )
      SELECT * FROM deduplicated
      WHERE source_event_rank=1
        AND ($3::timestamptz IS NULL OR (occurred_at,source_id,collection_id,record_id,current_revision)
          < ($3::timestamptz,$4::text,$5::text,$6::text,$7::bigint))
      ORDER BY occurred_at DESC,source_id DESC,collection_id DESC,record_id DESC,current_revision DESC
      LIMIT $8
    `, [
      request.subject.tenantId, collectionIds,
      cursor?.o ?? null, cursor?.s ?? null, cursor?.c ?? null, cursor?.r ?? null, cursor?.v ?? null,
      limit,
    ]);
    throwIfAborted(request.signal);

    // Keep this guard even though SQL filters it: mocked/alternate pools cannot bypass delete semantics.
    const candidates = (result.rows as Row[]).filter(row => {
      const locator = contextSourceLocatorFromRow(row);
      return !(locator.recordType === 'snapshot' && locator.deleted);
    });
    const deduped: Row[] = [];
    const sourceEventIndexes = new Map<string, number>();
    for (const row of candidates) {
      const locator = contextSourceLocatorFromRow(row);
      if (!locator.sourceEventId) {
        deduped.push(row);
        continue;
      }
      const existingIndex = sourceEventIndexes.get(locator.sourceEventId);
      if (existingIndex === undefined) {
        sourceEventIndexes.set(locator.sourceEventId, deduped.length);
        deduped.push(row);
      } else if (locator.recordType === 'event'
        && contextSourceLocatorFromRow(deduped[existingIndex]!).recordType !== 'event') {
        deduped[existingIndex] = row;
      }
    }

    const registry = this.options.sourceAuthorizationRegistry ?? new ContextSourceAuthorizationRegistry();
    const decisions = await registry.authorizeBatch(
      { tenantId: request.subject.tenantId, userId: request.subject.userId },
      deduped.map(row => contextSourceLocatorFromRow(row)),
    );
    const reasons: ContextSourceAuthorizationDenyReason[] = [];
    const items = deduped.flatMap((row, index) => {
      const decision = decisions[index]!;
      if (decision.reason && !reasons.includes(decision.reason)) reasons.push(decision.reason);
      return decision.authorized ? [itemFromRow(row)] : [];
    });
    const lastScanned = (result.rows as Row[]).at(-1);
    const nextCursor = result.rows.length === limit && lastScanned
      ? encodeCursor(cursorFromRow(request.subject.tenantId, lastScanned), this.cursorSigningKey)
      : undefined;
    return {
      items,
      ...(nextCursor ? { nextCursor } : {}),
      degraded: reasons.length > 0,
      ...(reasons.length ? { degradationReasons: reasons } : {}),
    };
  }
}

function itemFromRow(row: Row): ContextTimelineItem {
  const locator = contextSourceLocatorFromRow(row);
  return {
    sourceId: locator.sourceId,
    collectionId: locator.collectionId,
    recordId: locator.recordId,
    revision: locator.revision,
    sourceKind: locator.sourceKind,
    recordType: locator.recordType,
    ...(locator.sourceEventId ? { sourceEventId: locator.sourceEventId } : {}),
    ...(locator.eventType ? { eventType: locator.eventType } : {}),
    occurredAt: iso(row.occurred_at),
    content: jsonValue(row.content_json),
    metadata: locator.metadata,
  };
}

function cursorFromRow(tenantId: string, row: Row): TimelineCursorPayload {
  return {
    t: tenantId,
    o: iso(row.occurred_at),
    s: String(row.source_id),
    c: String(row.collection_id),
    r: String(row.record_id),
    v: Number(row.current_revision),
  };
}

function encodeCursor(value: TimelineCursorPayload, signingKey: string): string {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `ct1.${payload}.${sign(payload, signingKey)}`;
}

function decodeCursor(value: string, signingKey: string): TimelineCursorPayload | null {
  if (!value.startsWith('ct1.') || value.length > 1024) return null;
  try {
    const parts = value.split('.');
    if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
    const expected = Buffer.from(sign(parts[1], signingKey));
    const actual = Buffer.from(parts[2]);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof parsed.t !== 'string' || typeof parsed.o !== 'string' || typeof parsed.s !== 'string'
      || typeof parsed.c !== 'string' || typeof parsed.r !== 'string' || !Number.isSafeInteger(parsed.v)) return null;
    return { t: parsed.t, o: iso(parsed.o), s: parsed.s, c: parsed.c, r: parsed.r, v: Number(parsed.v) };
  } catch {
    return null;
  }
}

function sign(payload: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(`context-timeline:${payload}`).digest('base64url');
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function jsonValue(value: unknown): ContextJson {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed as ContextJson;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('CONTEXT_TIMELINE_ABORTED');
}
