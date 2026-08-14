import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { PgGovernanceMigrationRunner, governanceTablePrefix } from '../governance-schema/index.js';
import {
  AgentDwsMessageInvariantError,
  type AgentDwsConversationBindingRecord,
  type AgentDwsInboxRecord,
  type AgentDwsIngestResult,
  type AgentDwsMessageStore,
  type AgentDwsNormalizedEvent,
  type AgentDwsPayload,
} from './types.js';

const MAX_PAYLOAD_BYTES = 256 * 1024;
const PAYLOAD_SIZE_MARGIN = 128;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1_000;

type PgPool = pg.Pool;

export class PgAgentDwsMessageStore implements AgentDwsMessageStore {
  readonly inboxTable: string;
  readonly bindingsTable: string;
  private readonly tablePrefix: string;

  constructor(private readonly pool: PgPool, tablePrefix?: string) {
    this.tablePrefix = governanceTablePrefix(tablePrefix);
    this.inboxTable = `${this.tablePrefix}_agent_dws_event_inbox`;
    this.bindingsTable = `${this.tablePrefix}_agent_dws_conversation_bindings`;
  }

  async init(): Promise<void> {
    await new PgGovernanceMigrationRunner(this.pool, this.tablePrefix).run();
  }

  async ingest(event: AgentDwsNormalizedEvent, rawPayload: unknown): Promise<AgentDwsIngestResult> {
    assertEvent(event);
    const payload = normalizePayload(rawPayload);
    const eventTimestamp = optionalDate(event.eventTimestamp);
    const result = await this.pool.query(`
      INSERT INTO ${this.inboxTable} AS inbox (
        inbox_id,tenant_id,account_id,event_id,event_type,conversation_id,message_id,
        sender_open_dingtalk_id,content,event_timestamp,payload_json,state,attempt,
        max_attempts,lease_fence,next_attempt_at,created_at,updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11::jsonb,'pending',0,$12,0,NOW(),NOW(),NOW()
      )
      ON CONFLICT (account_id,event_id) DO UPDATE
      SET event_id=inbox.event_id
      RETURNING inbox.*,(xmax=0) AS created
    `, [
      `adwsi-${randomUUID()}`,
      event.tenantId,
      event.accountId,
      event.eventId,
      event.eventType,
      event.conversationId,
      optionalText(event.messageId),
      optionalText(event.senderOpenDingtalkId),
      event.content,
      eventTimestamp,
      JSON.stringify(payload),
      event.maxAttempts ?? 8,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
    return { record: mapInboxRow(row), created: booleanValue(row.created) };
  }

  async claimNext(owner: string, ttlMs: number): Promise<AgentDwsInboxRecord | null> {
    assertOwnerFence(owner, 1, false);
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_TTL_MS) {
      throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        WITH candidate AS (
          SELECT item.inbox_id
          FROM ${this.inboxTable} item
          WHERE (
            item.state='pending'
            OR (item.state='retry_wait' AND item.next_attempt_at <= NOW())
            OR (item.state='reply_pending' AND (
              item.lease_expires_at IS NULL OR item.lease_expires_at <= NOW()
            ))
            OR (item.state='processing' AND item.lease_expires_at <= NOW())
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${this.inboxTable} active
            WHERE active.account_id=item.account_id
              AND active.conversation_id=item.conversation_id
              AND active.inbox_id<>item.inbox_id
              AND (active.state='processing' OR active.state='reply_pending')
              AND active.lease_expires_at > NOW()
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${this.inboxTable} earlier
            WHERE earlier.account_id=item.account_id
              AND earlier.conversation_id=item.conversation_id
              AND earlier.state IN ('pending','processing','retry_wait','reply_pending')
              AND (
                COALESCE(earlier.event_timestamp,earlier.created_at),
                earlier.created_at,
                earlier.inbox_id
              ) < (
                COALESCE(item.event_timestamp,item.created_at),
                item.created_at,
                item.inbox_id
              )
          )
          ORDER BY COALESCE(item.event_timestamp,item.created_at),item.created_at,item.inbox_id
          FOR UPDATE OF item SKIP LOCKED
          LIMIT 1
        )
        UPDATE ${this.inboxTable} inbox
        SET state='processing',attempt=inbox.attempt+1,lease_owner=$1,
            lease_fence=inbox.lease_fence+1,
            lease_expires_at=NOW()+($2::bigint * INTERVAL '1 millisecond'),
            next_attempt_at=NULL,updated_at=NOW()
        FROM candidate
        WHERE inbox.inbox_id=candidate.inbox_id
        RETURNING inbox.*
      `, [owner, ttlMs]);
      await client.query('COMMIT');
      const row = result.rows[0] as Record<string, unknown> | undefined;
      return row ? mapInboxRow(row) : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async renewLease(
    inboxId: string,
    owner: string,
    fence: number,
    ttlMs: number,
  ): Promise<boolean> {
    assertOwnerFence(owner, fence);
    assertTexts(inboxId);
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_TTL_MS) {
      throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
    }
    const result = await this.pool.query(`
      UPDATE ${this.inboxTable}
      SET lease_expires_at=NOW()+($4::bigint * INTERVAL '1 millisecond'),updated_at=NOW()
      WHERE inbox_id=$1 AND state IN ('processing','reply_pending')
        AND lease_owner=$2 AND lease_fence=$3 AND lease_expires_at > NOW()
      RETURNING inbox_id
    `, [inboxId, owner, fence, ttlMs]);
    return Boolean(result.rows[0]);
  }

  async getOrCreateBinding(
    tenantId: string,
    accountId: string,
    conversationId: string,
    candidateSessionId: string,
  ): Promise<AgentDwsConversationBindingRecord> {
    assertTexts(tenantId, accountId, conversationId, candidateSessionId);
    const result = await this.pool.query(`
      INSERT INTO ${this.bindingsTable} AS binding (
        binding_id,tenant_id,account_id,conversation_id,session_id,created_at,updated_at
      ) VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
      ON CONFLICT (account_id,conversation_id) DO UPDATE
      SET updated_at=binding.updated_at
      RETURNING binding.*
    `, [`adwsb-${randomUUID()}`, tenantId, accountId, conversationId, candidateSessionId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
    return mapBindingRow(row);
  }

  async markDispatchStarted(
    inboxId: string,
    owner: string,
    fence: number,
    sessionId: string,
    runId?: string,
  ): Promise<AgentDwsInboxRecord> {
    assertOwnerFence(owner, fence);
    assertTexts(inboxId, sessionId);
    if (runId !== undefined) assertTexts(runId);
    return await this.updateWithLease(`
      UPDATE ${this.inboxTable}
      SET session_id=$4,run_id=COALESCE($5,run_id),updated_at=NOW()
      WHERE inbox_id=$1 AND state='processing' AND lease_owner=$2 AND lease_fence=$3
        AND lease_expires_at > NOW()
      RETURNING *
    `, [inboxId, owner, fence, sessionId, runId ?? null]);
  }

  async saveDispatchResult(
    inboxId: string,
    owner: string,
    fence: number,
    responseText: string,
  ): Promise<AgentDwsInboxRecord> {
    assertOwnerFence(owner, fence);
    assertTexts(inboxId);
    if (typeof responseText !== 'string') {
      throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
    }
    return await this.updateWithLease(`
      UPDATE ${this.inboxTable}
      SET state='reply_pending',response_text=$4,last_error=NULL,updated_at=NOW()
      WHERE inbox_id=$1 AND state='processing' AND lease_owner=$2 AND lease_fence=$3
        AND lease_expires_at > NOW()
      RETURNING *
    `, [inboxId, owner, fence, responseText]);
  }

  async markReplyAttemptStarted(
    inboxId: string,
    owner: string,
    fence: number,
  ): Promise<AgentDwsInboxRecord> {
    assertOwnerFence(owner, fence);
    assertTexts(inboxId);
    return await this.updateWithLease(`
      UPDATE ${this.inboxTable}
      SET reply_started_at=COALESCE(reply_started_at,NOW()),updated_at=NOW()
      WHERE inbox_id=$1 AND state='reply_pending'
        AND lease_owner=$2 AND lease_fence=$3 AND lease_expires_at > NOW()
      RETURNING *
    `, [inboxId, owner, fence]);
  }

  async defer(
    inboxId: string,
    owner: string,
    fence: number,
    delayMs: number,
    reason: string,
  ): Promise<AgentDwsInboxRecord> {
    assertOwnerFence(owner, fence);
    assertTexts(inboxId, reason);
    if (!Number.isInteger(delayMs) || delayMs < 1 || delayMs > MAX_RETRY_DELAY_MS) {
      throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
    }
    return await this.updateWithLease(`
      UPDATE ${this.inboxTable}
      SET state='retry_wait',attempt=GREATEST(attempt-1,0),
          lease_owner=NULL,lease_expires_at=NULL,
          next_attempt_at=NOW()+($5::bigint * INTERVAL '1 millisecond'),
          last_error=$4,updated_at=NOW()
      WHERE inbox_id=$1 AND state IN ('processing','reply_pending')
        AND lease_owner=$2 AND lease_fence=$3 AND lease_expires_at > NOW()
      RETURNING *
    `, [inboxId, owner, fence, compactError(reason), delayMs]);
  }

  async complete(inboxId: string, owner: string, fence: number): Promise<AgentDwsInboxRecord> {
    assertOwnerFence(owner, fence);
    assertTexts(inboxId);
    return await this.updateWithLease(`
      UPDATE ${this.inboxTable}
      SET state='completed',lease_owner=NULL,lease_expires_at=NULL,next_attempt_at=NULL,
          last_error=NULL,completed_at=NOW(),updated_at=NOW()
      WHERE inbox_id=$1 AND state IN ('processing','reply_pending')
        AND lease_owner=$2 AND lease_fence=$3 AND lease_expires_at > NOW()
      RETURNING *
    `, [inboxId, owner, fence]);
  }

  async fail(
    inboxId: string,
    owner: string,
    fence: number,
    error: unknown,
    retryDelayMs?: number,
  ): Promise<AgentDwsInboxRecord> {
    assertOwnerFence(owner, fence);
    assertTexts(inboxId);
    if (retryDelayMs !== undefined && (
      !Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > MAX_RETRY_DELAY_MS
    )) {
      throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
    }
    return await this.updateWithLease(`
      UPDATE ${this.inboxTable}
      SET state=CASE WHEN attempt>=max_attempts THEN 'dead_letter' ELSE 'retry_wait' END,
          lease_owner=NULL,lease_expires_at=NULL,
          next_attempt_at=CASE
            WHEN attempt>=max_attempts THEN NULL
            ELSE NOW()+(
              COALESCE(
                $5::bigint,
                LEAST(300000::bigint,(1000*POWER(2,LEAST(attempt-1,8)))::bigint)
              ) * INTERVAL '1 millisecond'
            )
          END,
          last_error=$4,
          completed_at=CASE WHEN attempt>=max_attempts THEN NOW() ELSE NULL END,
          updated_at=NOW()
      WHERE inbox_id=$1 AND state IN ('processing','reply_pending')
        AND lease_owner=$2 AND lease_fence=$3 AND lease_expires_at > NOW()
      RETURNING *
    `, [inboxId, owner, fence, compactError(error), retryDelayMs ?? null]);
  }

  async deleteForTenant(tenantId: string): Promise<number> {
    assertTexts(tenantId);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const bindings = await client.query(
        `DELETE FROM ${this.bindingsTable} WHERE tenant_id=$1`, [tenantId],
      );
      const inbox = await client.query(
        `DELETE FROM ${this.inboxTable} WHERE tenant_id=$1`, [tenantId],
      );
      await client.query('COMMIT');
      return (bindings.rowCount ?? 0) + (inbox.rowCount ?? 0);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async updateWithLease(sql: string, values: readonly unknown[]): Promise<AgentDwsInboxRecord> {
    const result = await this.pool.query(sql, values as unknown[]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_LEASE_LOST');
    return mapInboxRow(row);
  }
}

function mapInboxRow(row: Record<string, unknown>): AgentDwsInboxRecord {
  return {
    inboxId: String(row.inbox_id),
    tenantId: String(row.tenant_id),
    accountId: String(row.account_id),
    eventId: String(row.event_id),
    eventType: String(row.event_type),
    conversationId: String(row.conversation_id),
    ...(optionalText(row.message_id) ? { messageId: optionalText(row.message_id) } : {}),
    ...(optionalText(row.sender_open_dingtalk_id)
      ? { senderOpenDingtalkId: optionalText(row.sender_open_dingtalk_id) }
      : {}),
    content: String(row.content),
    ...(row.event_timestamp ? { eventTimestamp: iso(row.event_timestamp) } : {}),
    payload: parsePayload(row.payload_json),
    state: row.state as AgentDwsInboxRecord['state'],
    ...(optionalText(row.session_id) ? { sessionId: optionalText(row.session_id) } : {}),
    ...(optionalText(row.run_id) ? { runId: optionalText(row.run_id) } : {}),
    ...(typeof row.response_text === 'string' ? { responseText: row.response_text } : {}),
    ...(row.reply_started_at ? { replyStartedAt: iso(row.reply_started_at) } : {}),
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    ...(optionalText(row.lease_owner) ? { leaseOwner: optionalText(row.lease_owner) } : {}),
    leaseFence: Number(row.lease_fence),
    ...(row.lease_expires_at ? { leaseExpiresAt: iso(row.lease_expires_at) } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at) } : {}),
    ...(optionalText(row.last_error) ? { lastError: optionalText(row.last_error) } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.completed_at ? { completedAt: iso(row.completed_at) } : {}),
  };
}

function mapBindingRow(row: Record<string, unknown>): AgentDwsConversationBindingRecord {
  return {
    bindingId: String(row.binding_id),
    tenantId: String(row.tenant_id),
    accountId: String(row.account_id),
    conversationId: String(row.conversation_id),
    sessionId: String(row.session_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function parsePayload(value: unknown): AgentDwsPayload {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as AgentDwsPayload
      : {};
  } catch {
    throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
  }
}

function normalizePayload(value: unknown): AgentDwsPayload {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      parsed = { value };
    }
  }
  let object = jsonSafeObject(parsed);
  if (payloadFits(object)) return object;

  if (Object.prototype.hasOwnProperty.call(object, 'raw')) {
    const { raw: _omitted, ...withoutRaw } = object;
    object = { ...withoutRaw, _rawOmitted: true };
    if (payloadFits(object)) return object;
  }

  const serialized = safeStringify(object);
  let low = 0;
  let high = serialized.length;
  let winner: AgentDwsPayload = { _truncated: true };
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = { _truncated: true, _preview: serialized.slice(0, middle) };
    if (payloadFits(candidate)) {
      winner = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return winner;
}

function jsonSafeObject(value: unknown): AgentDwsPayload {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'number' && !Number.isFinite(item)) return null;
      // PostgreSQL JSONB expands exponent notation; store it as text so the app-side byte cap remains hard.
      if (typeof item === 'number' && /e/i.test(item.toString())) return item.toString();
      if (item instanceof Error) return { name: item.name, message: item.message };
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
    if (serialized === undefined) return {};
    const parsed = JSON.parse(serialized) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AgentDwsPayload;
    }
    return { value: parsed };
  } catch {
    return { _truncated: true, _reason: 'unserializable' };
  }
}

function payloadFits(value: AgentDwsPayload): boolean {
  const serialized = safeStringify(value);
  return Buffer.byteLength(serialized, 'utf8') + jsonbFormattingOverhead(value)
    <= MAX_PAYLOAD_BYTES - PAYLOAD_SIZE_MARGIN;
}

function jsonbFormattingOverhead(value: unknown): number {
  let overhead = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (Array.isArray(item)) {
      overhead += Math.max(0, item.length - 1);
      for (const value of item) stack.push(value);
    } else if (item && typeof item === 'object') {
      const values = Object.values(item as Record<string, unknown>);
      overhead += values.length + Math.max(0, values.length - 1);
      for (const value of values) stack.push(value);
    }
  }
  return overhead;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '{}';
  } catch {
    return '{}';
  }
}

function compactError(error: unknown): string {
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'unknown_error';
  return raw
    .replace(/\b(?:bearer|basic)\s+\S+/gi, '[REDACTED]')
    .replace(/\b(authorization|cookie|password|passwd|secret|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500) || 'unknown_error';
}

function assertEvent(event: AgentDwsNormalizedEvent): void {
  if (!event || typeof event !== 'object') {
    throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
  }
  assertTexts(
    event.tenantId,
    event.accountId,
    event.eventId,
    event.eventType,
    event.conversationId,
  );
  if (typeof event.content !== 'string') {
    throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
  }
  if (event.maxAttempts !== undefined && (
    !Number.isInteger(event.maxAttempts) || event.maxAttempts < 1 || event.maxAttempts > 100
  )) {
    throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
  }
  optionalDate(event.eventTimestamp);
}

function assertOwnerFence(owner: string, fence: number, requireFence = true): void {
  assertTexts(owner);
  if (requireFence && (!Number.isSafeInteger(fence) || fence < 1)) {
    throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
  }
}

function assertTexts(...values: string[]): void {
  if (values.some(value => typeof value !== 'string' || !value.trim())) {
    throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalDate(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
  }
  return date.toISOString();
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new AgentDwsMessageInvariantError('AGENT_DWS_MESSAGE_INVALID');
  }
  return date.toISOString();
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 't' || value === 'true';
}
