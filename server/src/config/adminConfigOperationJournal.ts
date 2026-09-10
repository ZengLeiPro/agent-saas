import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  atomicWrite,
  authorityDirectory,
  canonical,
} from '../../../scripts/release/config-publication.mjs';
import type { AdminConfigOperationId } from './adminConfigOperationRegistry.js';

export type AdminConfigOperationState =
  | 'preparing'
  | 'publishing'
  | 'applied'
  | 'committed_unconfirmed'
  | 'rolled_back'
  | 'not_committed'
  | 'recovery_required';

export interface AdminConfigOperationRecord {
  schemaVersion: 1;
  operationId: string;
  operation: AdminConfigOperationId;
  actorDigest: string;
  semanticDigest: string;
  state: AdminConfigOperationState;
  beforeRevision: string;
  candidateRevision?: string;
  publicationRevision?: string;
  updatedAt: string;
}

export class AdminConfigOperationConflictError extends Error {
  readonly code = 'CONFIG_OPERATION_ID_CONFLICT';
  constructor() {
    super('operationId 已绑定其他操作者、操作或请求内容');
  }
}

export class AdminConfigOperationPendingError extends Error {
  readonly code = 'CONFIG_OPERATION_RESULT_UNKNOWN';
  constructor(readonly state: AdminConfigOperationState) {
    super('该配置操作结果尚未完全确认，请先查询原 operationId');
  }
}

export class AdminConfigOperationJournal {
  private readonly root: string;
  private readonly key: Buffer;

  constructor(private readonly configPath: string) {
    const authority = authorityDirectory(configPath);
    this.root = join(authority, 'operations');
    this.key = createHash('sha256')
      .update(readFileSync(join(authority, 'private.pem')))
      .update('agent-saas-admin-config-operation-v1')
      .digest();
  }

  private digest(value: unknown): string {
    return createHmac('sha256', this.key).update(canonical(value)).digest('hex');
  }

  private path(operationId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(operationId)) {
      throw new AdminConfigOperationConflictError();
    }
    return join(this.root, `${createHash('sha256').update(operationId).digest('hex')}.json`);
  }

  read(operationId: string): AdminConfigOperationRecord | undefined {
    const path = this.path(operationId);
    if (!existsSync(path)) return undefined;
    const record = JSON.parse(readFileSync(path, 'utf8')) as AdminConfigOperationRecord;
    if (record.schemaVersion !== 1 || record.operationId !== operationId) {
      throw new AdminConfigOperationConflictError();
    }
    return record;
  }

  begin(input: {
    operationId: string;
    operation: AdminConfigOperationId;
    actor: string;
    semantic: unknown;
    beforeRevision: string;
    now: string;
  }): AdminConfigOperationRecord {
    const existing = this.read(input.operationId);
    const actorDigest = this.digest({ actor: input.actor });
    const semanticDigest = this.digest({ operation: input.operation, semantic: input.semantic });
    if (existing) {
      if (
        existing.actorDigest !== actorDigest ||
        existing.semanticDigest !== semanticDigest ||
        existing.operation !== input.operation
      )
        throw new AdminConfigOperationConflictError();
      return existing;
    }
    const record: AdminConfigOperationRecord = {
      schemaVersion: 1,
      operationId: input.operationId,
      operation: input.operation,
      actorDigest,
      semanticDigest,
      state: 'preparing',
      beforeRevision: input.beforeRevision,
      updatedAt: input.now,
    };
    this.write(record);
    return record;
  }

  owns(record: AdminConfigOperationRecord, actor: string): boolean {
    return record.actorDigest === this.digest({ actor });
  }

  findByPublicationRevision(publicationRevision: string): AdminConfigOperationRecord | undefined {
    if (!existsSync(this.root)) return undefined;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(
          readFileSync(join(this.root, entry.name), 'utf8'),
        ) as AdminConfigOperationRecord;
        if (record.schemaVersion === 1 && record.publicationRevision === publicationRevision)
          return record;
      } catch {
        // A malformed journal is never accepted as evidence for an operation.
      }
    }
    return undefined;
  }

  update(
    record: AdminConfigOperationRecord,
    patch: Partial<AdminConfigOperationRecord>,
  ): AdminConfigOperationRecord {
    const next = { ...record, ...patch, schemaVersion: 1 as const };
    this.write(next);
    return next;
  }

  private write(record: AdminConfigOperationRecord): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    atomicWrite(this.path(record.operationId), `${JSON.stringify(record)}\n`);
  }
}
