/**
 * §4.3 / §4.4 执行记录的 PostgreSQL 实现。
 *
 * `(installation_id, capability_id, sub, lcid)` 是主键，`begin()` 用
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING` 做原子「不存在才插入」，
 * 并发下只有一个调用拿到 `created:true`，其余读回既有记录。
 */
import type { Pool } from 'pg';

import { EXECUTION_RETENTION_MS } from './executionStore.js';
import type {
  ExecutionFinishPatch,
  ExecutionKey,
  ExecutionRecord,
  ExecutionStore,
  ExecutionState,
} from './executionStore.js';

interface ExecutionRow {
  installation_id: string;
  capability_id: string;
  sub: string;
  lcid: string;
  input_hash: string;
  status: ExecutionState;
  result: unknown;
  error: { code: string; message?: string } | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}

function toRecord(row: ExecutionRow): ExecutionRecord {
  return {
    installationId: row.installation_id,
    capabilityId: row.capability_id,
    sub: row.sub,
    lcid: row.lcid,
    inputHash: row.input_hash,
    status: row.status,
    ...(row.result === null || row.result === undefined ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    expiresAt: row.expires_at.getTime(),
  };
}

const COLUMNS =
  'installation_id, capability_id, sub, lcid, input_hash, status, result, error, created_at, updated_at, expires_at';

export class PgExecutionStore implements ExecutionStore {
  constructor(private readonly pool: Pool) {}

  async begin(record: ExecutionRecord): Promise<{ created: boolean; record: ExecutionRecord }> {
    const inserted = await this.pool.query<ExecutionRow>(
      `INSERT INTO ky_app_execution (${COLUMNS})
       VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,$7,$8,$9)
       ON CONFLICT (installation_id, capability_id, sub, lcid) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        record.installationId,
        record.capabilityId,
        record.sub,
        record.lcid,
        record.inputHash,
        record.status,
        new Date(record.createdAt),
        new Date(record.updatedAt),
        new Date(record.expiresAt),
      ],
    );
    if (inserted.rowCount === 1) return { created: true, record: toRecord(inserted.rows[0]) };
    const existing = await this.get(record);
    if (existing === null) {
      // 并发窗口内被清理掉了：按新建处理，交给上层重试。
      return { created: true, record };
    }
    return { created: false, record: existing };
  }

  async finish(key: ExecutionKey, patch: ExecutionFinishPatch): Promise<void> {
    await this.pool.query(
      `UPDATE ky_app_execution
          SET status = $5,
              result = $6::jsonb,
              error = $7::jsonb,
              updated_at = $8,
              expires_at = $9
        WHERE installation_id = $1 AND capability_id = $2 AND sub = $3 AND lcid = $4`,
      [
        key.installationId,
        key.capabilityId,
        key.sub,
        key.lcid,
        patch.status,
        patch.result === undefined ? null : JSON.stringify(patch.result),
        patch.error === undefined ? null : JSON.stringify(patch.error),
        new Date(patch.at),
        new Date(patch.at + EXECUTION_RETENTION_MS),
      ],
    );
  }

  async get(key: ExecutionKey): Promise<ExecutionRecord | null> {
    const result = await this.pool.query<ExecutionRow>(
      `SELECT ${COLUMNS} FROM ky_app_execution
        WHERE installation_id = $1 AND capability_id = $2 AND sub = $3 AND lcid = $4`,
      [key.installationId, key.capabilityId, key.sub, key.lcid],
    );
    return result.rowCount === 1 ? toRecord(result.rows[0]) : null;
  }

  async findByLcid(input: {
    installationId: string;
    capabilityId: string;
    lcid: string;
  }): Promise<ExecutionRecord | null> {
    const result = await this.pool.query<ExecutionRow>(
      `SELECT ${COLUMNS} FROM ky_app_execution
        WHERE installation_id = $1 AND capability_id = $2 AND lcid = $3
        LIMIT 1`,
      [input.installationId, input.capabilityId, input.lcid],
    );
    return result.rowCount === 1 ? toRecord(result.rows[0]) : null;
  }

  async expireOverdue(nowMs: number): Promise<number> {
    const result = await this.pool.query(
      `UPDATE ky_app_execution
          SET status = 'expired', result = NULL, updated_at = $1
        WHERE status IN ('done','failed') AND expires_at <= $1`,
      [new Date(nowMs)],
    );
    return result.rowCount ?? 0;
  }
}
