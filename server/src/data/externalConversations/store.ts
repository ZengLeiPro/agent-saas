// release-migration: expand

import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

import {
  externalConversationSchemaStatements,
  externalConversationTables,
  type ExternalConversationTables,
} from './schema.js';
import type {
  ExternalConversationRecord,
  ExternalConversationStore,
  ExternalExecutionRecord,
  IdempotentCreateResult,
} from './types.js';

type PgPool = pg.Pool;

function newId(prefix: 'conv' | 'exec'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

export function externalClientMessageId(clientId: string, idempotencyKey: string): string {
  const digest = createHash('sha256')
    .update(`${clientId}\0${idempotencyKey}`)
    .digest('hex')
    .slice(0, 40);
  return `external:${digest}`;
}

function cloneConversation(record: ExternalConversationRecord): ExternalConversationRecord {
  return { ...record, metadata: structuredClone(record.metadata) };
}

function cloneExecution(record: ExternalExecutionRecord): ExternalExecutionRecord {
  return { ...record };
}

function conversationRow(row: Record<string, unknown>): ExternalConversationRecord {
  return {
    conversationId: String(row.conversation_id),
    clientId: String(row.client_id),
    tenantId: String(row.tenant_id),
    serviceAccountUserId: String(row.service_account_user_id),
    externalConversationId: String(row.external_conversation_id),
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    ...(row.database_connection_id
      ? { databaseConnectionId: String(row.database_connection_id) }
      : {}),
    ...(row.agent_id ? { agentId: String(row.agent_id) } : {}),
    metadata:
      row.metadata_json && typeof row.metadata_json === 'object'
        ? structuredClone(row.metadata_json as Record<string, unknown>)
        : {},
    status: row.status as ExternalConversationRecord['status'],
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function executionRow(row: Record<string, unknown>): ExternalExecutionRecord {
  return {
    executionId: String(row.execution_id),
    conversationId: String(row.conversation_id),
    clientId: String(row.client_id),
    tenantId: String(row.tenant_id),
    serviceAccountUserId: String(row.service_account_user_id),
    ...(row.run_id ? { runId: String(row.run_id) } : {}),
    ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    clientMessageId: String(row.client_message_id),
    idempotencyKey: String(row.idempotency_key),
    requestHash: String(row.request_hash),
    submissionStatus: row.submission_status as ExternalExecutionRecord['submissionStatus'],
    ...(row.requested_model ? { requestedModel: String(row.requested_model) } : {}),
    ...(row.requested_reasoning_effort
      ? { requestedReasoningEffort: String(row.requested_reasoning_effort) }
      : {}),
    ...(row.error_code ? { errorCode: String(row.error_code) } : {}),
    ...(row.error_message ? { errorMessage: String(row.error_message) } : {}),
    createdAt: new Date(row.created_at as string | Date).toISOString(),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

export class InMemoryExternalConversationStore implements ExternalConversationStore {
  private readonly conversations = new Map<string, ExternalConversationRecord>();
  private readonly executions = new Map<string, ExternalExecutionRecord>();

  async createConversation(
    input: Parameters<ExternalConversationStore['createConversation']>[0],
  ): Promise<IdempotentCreateResult<ExternalConversationRecord>> {
    const existing = [...this.conversations.values()].find(
      (candidate) =>
        candidate.clientId === input.clientId &&
        (candidate.idempotencyKey === input.idempotencyKey ||
          candidate.externalConversationId === input.externalConversationId),
    );
    if (existing) {
      return {
        outcome: existing.requestHash === input.requestHash ? 'replay' : 'conflict',
        record: cloneConversation(existing),
      };
    }
    const now = new Date().toISOString();
    const record: ExternalConversationRecord = {
      conversationId: newId('conv'),
      clientId: input.clientId,
      tenantId: input.tenantId,
      serviceAccountUserId: input.serviceAccountUserId,
      externalConversationId: input.externalConversationId,
      ...(input.databaseConnectionId ? { databaseConnectionId: input.databaseConnectionId } : {}),
      ...(input.agentId ? { agentId: input.agentId } : {}),
      metadata: structuredClone(input.metadata),
      status: 'active',
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(record.conversationId, record);
    return { outcome: 'created', record: cloneConversation(record) };
  }

  async getConversation(conversationId: string): Promise<ExternalConversationRecord | undefined> {
    const record = this.conversations.get(conversationId);
    return record ? cloneConversation(record) : undefined;
  }

  async listConversations(
    input: Parameters<ExternalConversationStore['listConversations']>[0],
  ): Promise<ExternalConversationRecord[]> {
    return [...this.conversations.values()]
      .filter(
        (record) =>
          record.tenantId === input.tenantId &&
          (!input.clientId || record.clientId === input.clientId),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, input.limit ?? 100)
      .map(cloneConversation);
  }

  async reserveExecution(
    input: Parameters<ExternalConversationStore['reserveExecution']>[0],
  ): Promise<IdempotentCreateResult<ExternalExecutionRecord>> {
    const existing = [...this.executions.values()].find(
      (candidate) =>
        candidate.clientId === input.conversation.clientId &&
        candidate.idempotencyKey === input.idempotencyKey,
    );
    if (existing) {
      return {
        outcome: existing.requestHash === input.requestHash ? 'replay' : 'conflict',
        record: cloneExecution(existing),
      };
    }
    const now = new Date().toISOString();
    const executionId = newId('exec');
    const record: ExternalExecutionRecord = {
      executionId,
      conversationId: input.conversation.conversationId,
      clientId: input.conversation.clientId,
      tenantId: input.conversation.tenantId,
      serviceAccountUserId: input.conversation.serviceAccountUserId,
      clientMessageId: externalClientMessageId(input.conversation.clientId, input.idempotencyKey),
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      submissionStatus: 'submitting',
      ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
      ...(input.requestedReasoningEffort
        ? { requestedReasoningEffort: input.requestedReasoningEffort }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.executions.set(executionId, record);
    return { outcome: 'created', record: cloneExecution(record) };
  }

  async getExecution(executionId: string): Promise<ExternalExecutionRecord | undefined> {
    const record = this.executions.get(executionId);
    return record ? cloneExecution(record) : undefined;
  }

  async listExecutions(
    input: Parameters<ExternalConversationStore['listExecutions']>[0],
  ): Promise<ExternalExecutionRecord[]> {
    return [...this.executions.values()]
      .filter(
        (record) =>
          record.tenantId === input.tenantId &&
          (!input.clientId || record.clientId === input.clientId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, input.limit ?? 100)
      .map(cloneExecution);
  }

  async bindAcceptedExecution(
    input: Parameters<ExternalConversationStore['bindAcceptedExecution']>[0],
  ): Promise<ExternalExecutionRecord | undefined> {
    const execution = this.executions.get(input.executionId);
    const conversation = this.conversations.get(input.conversationId);
    if (!execution || !conversation) return undefined;
    if (execution.conversationId !== conversation.conversationId) return undefined;
    if (conversation.sessionId && conversation.sessionId !== input.sessionId) return undefined;
    const now = new Date().toISOString();
    this.conversations.set(conversation.conversationId, {
      ...conversation,
      sessionId: input.sessionId,
      updatedAt: now,
    });
    const updated: ExternalExecutionRecord = {
      ...execution,
      runId: input.runId,
      sessionId: input.sessionId,
      submissionStatus: 'accepted',
      updatedAt: now,
    };
    this.executions.set(execution.executionId, updated);
    return cloneExecution(updated);
  }

  async rejectExecution(
    input: Parameters<ExternalConversationStore['rejectExecution']>[0],
  ): Promise<ExternalExecutionRecord | undefined> {
    const execution = this.executions.get(input.executionId);
    if (!execution || execution.submissionStatus === 'accepted') return undefined;
    const updated: ExternalExecutionRecord = {
      ...execution,
      submissionStatus: 'rejected',
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      updatedAt: new Date().toISOString(),
    };
    this.executions.set(execution.executionId, updated);
    return cloneExecution(updated);
  }
}

export class PgExternalConversationStore implements ExternalConversationStore {
  readonly tables: ExternalConversationTables;
  private initialization?: Promise<void>;

  constructor(
    private readonly pool: PgPool,
    options: { tablePrefix?: string } = {},
  ) {
    this.tables = externalConversationTables(options.tablePrefix);
  }

  async init(): Promise<void> {
    this.initialization ??= this.initializeSchema();
    await this.initialization;
  }

  private async initializeSchema(): Promise<void> {
    const client = await this.pool.connect();
    const lockKey = `${this.tables.conversations}:init`;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      for (const statement of externalConversationSchemaStatements(this.tables)) {
        await client.query(statement);
      }
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey])
        .catch(() => undefined);
      client.release();
    }
  }

  async createConversation(
    input: Parameters<ExternalConversationStore['createConversation']>[0],
  ): Promise<IdempotentCreateResult<ExternalConversationRecord>> {
    await this.init();
    const conversationId = newId('conv');
    const inserted = await this.pool.query(
      `INSERT INTO ${this.tables.conversations} (
         conversation_id,client_id,tenant_id,service_account_user_id,
         external_conversation_id,database_connection_id,agent_id,metadata_json,
         idempotency_key,request_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        conversationId,
        input.clientId,
        input.tenantId,
        input.serviceAccountUserId,
        input.externalConversationId,
        input.databaseConnectionId ?? null,
        input.agentId ?? null,
        JSON.stringify(input.metadata),
        input.idempotencyKey,
        input.requestHash,
      ],
    );
    if (inserted.rows[0]) return { outcome: 'created', record: conversationRow(inserted.rows[0]) };
    const existing = await this.pool.query(
      `SELECT * FROM ${this.tables.conversations}
       WHERE client_id=$1 AND (idempotency_key=$2 OR external_conversation_id=$3)
       ORDER BY CASE WHEN idempotency_key=$2 THEN 0 ELSE 1 END LIMIT 1`,
      [input.clientId, input.idempotencyKey, input.externalConversationId],
    );
    const record = conversationRow(existing.rows[0]);
    return { outcome: record.requestHash === input.requestHash ? 'replay' : 'conflict', record };
  }

  async getConversation(conversationId: string): Promise<ExternalConversationRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.conversations} WHERE conversation_id=$1`,
      [conversationId],
    );
    return result.rows[0] ? conversationRow(result.rows[0]) : undefined;
  }

  async listConversations(
    input: Parameters<ExternalConversationStore['listConversations']>[0],
  ): Promise<ExternalConversationRecord[]> {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.conversations}
       WHERE tenant_id=$1 AND ($2::text IS NULL OR client_id=$2)
       ORDER BY updated_at DESC,conversation_id LIMIT $3`,
      [input.tenantId, input.clientId ?? null, Math.min(Math.max(input.limit ?? 100, 1), 500)],
    );
    return result.rows.map(conversationRow);
  }

  async reserveExecution(
    input: Parameters<ExternalConversationStore['reserveExecution']>[0],
  ): Promise<IdempotentCreateResult<ExternalExecutionRecord>> {
    await this.init();
    const executionId = newId('exec');
    const clientMessageId = externalClientMessageId(
      input.conversation.clientId,
      input.idempotencyKey,
    );
    const inserted = await this.pool.query(
      `INSERT INTO ${this.tables.executions} (
         execution_id,conversation_id,client_id,tenant_id,service_account_user_id,
         client_message_id,idempotency_key,request_hash,requested_model,requested_reasoning_effort
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING RETURNING *`,
      [
        executionId,
        input.conversation.conversationId,
        input.conversation.clientId,
        input.conversation.tenantId,
        input.conversation.serviceAccountUserId,
        clientMessageId,
        input.idempotencyKey,
        input.requestHash,
        input.requestedModel ?? null,
        input.requestedReasoningEffort ?? null,
      ],
    );
    if (inserted.rows[0]) return { outcome: 'created', record: executionRow(inserted.rows[0]) };
    const existing = await this.pool.query(
      `SELECT * FROM ${this.tables.executions} WHERE client_id=$1 AND idempotency_key=$2`,
      [input.conversation.clientId, input.idempotencyKey],
    );
    const record = executionRow(existing.rows[0]);
    return { outcome: record.requestHash === input.requestHash ? 'replay' : 'conflict', record };
  }

  async getExecution(executionId: string): Promise<ExternalExecutionRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.executions} WHERE execution_id=$1`,
      [executionId],
    );
    return result.rows[0] ? executionRow(result.rows[0]) : undefined;
  }

  async listExecutions(
    input: Parameters<ExternalConversationStore['listExecutions']>[0],
  ): Promise<ExternalExecutionRecord[]> {
    await this.init();
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.executions}
       WHERE tenant_id=$1 AND ($2::text IS NULL OR client_id=$2)
       ORDER BY created_at DESC,execution_id LIMIT $3`,
      [input.tenantId, input.clientId ?? null, Math.min(Math.max(input.limit ?? 100, 1), 500)],
    );
    return result.rows.map(executionRow);
  }

  async bindAcceptedExecution(
    input: Parameters<ExternalConversationStore['bindAcceptedExecution']>[0],
  ): Promise<ExternalExecutionRecord | undefined> {
    await this.init();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const conversation = await client.query(
        `UPDATE ${this.tables.conversations}
         SET session_id=COALESCE(session_id,$2),updated_at=NOW()
         WHERE conversation_id=$1 AND (session_id IS NULL OR session_id=$2)
         RETURNING conversation_id`,
        [input.conversationId, input.sessionId],
      );
      if (!conversation.rows[0]) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const execution = await client.query(
        `UPDATE ${this.tables.executions}
         SET run_id=$2,session_id=$3,submission_status='accepted',
             error_code=NULL,error_message=NULL,updated_at=NOW()
         WHERE execution_id=$1 AND conversation_id=$4
           AND (run_id IS NULL OR run_id=$2) AND submission_status<>'rejected'
         RETURNING *`,
        [input.executionId, input.runId, input.sessionId, input.conversationId],
      );
      if (!execution.rows[0]) {
        await client.query('ROLLBACK');
        return undefined;
      }
      await client.query('COMMIT');
      return executionRow(execution.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async rejectExecution(
    input: Parameters<ExternalConversationStore['rejectExecution']>[0],
  ): Promise<ExternalExecutionRecord | undefined> {
    await this.init();
    const result = await this.pool.query(
      `UPDATE ${this.tables.executions}
       SET submission_status='rejected',error_code=$2,error_message=$3,updated_at=NOW()
       WHERE execution_id=$1 AND submission_status<>'accepted' RETURNING *`,
      [input.executionId, input.errorCode, input.errorMessage],
    );
    return result.rows[0] ? executionRow(result.rows[0]) : undefined;
  }
}
