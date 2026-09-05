/**
 * §4.3 / §4.4 执行记录的存储契约与内存实现。
 *
 * `(iid, cap, sub, lcid)` 唯一；含输入 JCS sha256、状态机与结果；终态记录保留 7 天，
 * 过期后 `expired`。`begin()` 必须是原子的「不存在才插入」，并发下只能有一个调用拿到
 * `created:true`（PG 实现靠主键冲突）。
 */
import { CAPABILITY_EXECUTION_RETENTION_DAYS } from '@kaiyan/ky-app-contract';

/** 持久化的执行状态（`not_started` 只是查询结果，不落库）。 */
export type ExecutionState = 'in_progress' | 'done' | 'failed' | 'expired';

export interface ExecutionKey {
  installationId: string;
  capabilityId: string;
  sub: string;
  lcid: string;
}

export interface ExecutionRecord extends ExecutionKey {
  /** 输入的 sha256(JCS(input))。 */
  inputHash: string;
  status: ExecutionState;
  result?: unknown;
  error?: { code: string; message?: string };
  createdAt: number;
  updatedAt: number;
  /** 终态保留到期时刻（毫秒）。 */
  expiresAt: number;
}

export interface ExecutionFinishPatch {
  status: ExecutionState;
  result?: unknown;
  error?: { code: string; message?: string };
  at: number;
}

export interface ExecutionStore {
  /** 原子「不存在才插入」。已存在时返回既有记录。 */
  begin(record: ExecutionRecord): Promise<{ created: boolean; record: ExecutionRecord }>;
  /** 落终态。 */
  finish(key: ExecutionKey, patch: ExecutionFinishPatch): Promise<void>;
  get(key: ExecutionKey): Promise<ExecutionRecord | null>;
  /** 忽略 `sub` 查同 `(iid, cap, lcid)`，用于「不属于同一用户 → 404」判定。 */
  findByLcid(input: {
    installationId: string;
    capabilityId: string;
    lcid: string;
  }): Promise<ExecutionRecord | null>;
  /** 把超过保留期的终态记录标记为 `expired`；返回受影响行数。 */
  expireOverdue(nowMs: number): Promise<number>;
}

/** 保留期（毫秒）。 */
export const EXECUTION_RETENTION_MS = CAPABILITY_EXECUTION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

function keyOf(key: ExecutionKey): string {
  return [key.installationId, key.capabilityId, key.sub, key.lcid].join(' ');
}

/** 内存实现：测试与单进程开发用。 */
export class MemoryExecutionStore implements ExecutionStore {
  private readonly records = new Map<string, ExecutionRecord>();

  async begin(record: ExecutionRecord): Promise<{ created: boolean; record: ExecutionRecord }> {
    const id = keyOf(record);
    const existing = this.records.get(id);
    // get + set 之间没有 await，单线程下即原子。
    if (existing !== undefined) return { created: false, record: { ...existing } };
    this.records.set(id, { ...record });
    return { created: true, record: { ...record } };
  }

  async finish(key: ExecutionKey, patch: ExecutionFinishPatch): Promise<void> {
    const id = keyOf(key);
    const existing = this.records.get(id);
    if (existing === undefined) return;
    this.records.set(id, {
      ...existing,
      status: patch.status,
      ...(patch.result === undefined ? {} : { result: patch.result }),
      ...(patch.error === undefined ? {} : { error: patch.error }),
      updatedAt: patch.at,
      expiresAt: patch.at + EXECUTION_RETENTION_MS,
    });
  }

  async get(key: ExecutionKey): Promise<ExecutionRecord | null> {
    const record = this.records.get(keyOf(key));
    return record === undefined ? null : { ...record };
  }

  async findByLcid(input: {
    installationId: string;
    capabilityId: string;
    lcid: string;
  }): Promise<ExecutionRecord | null> {
    for (const record of this.records.values()) {
      if (
        record.installationId === input.installationId &&
        record.capabilityId === input.capabilityId &&
        record.lcid === input.lcid
      ) {
        return { ...record };
      }
    }
    return null;
  }

  async expireOverdue(nowMs: number): Promise<number> {
    let affected = 0;
    for (const [id, record] of this.records) {
      if (record.status === 'in_progress' || record.status === 'expired') continue;
      if (record.expiresAt > nowMs) continue;
      const expired: ExecutionRecord = { ...record, status: 'expired', updatedAt: nowMs };
      delete expired.result;
      this.records.set(id, expired);
      affected += 1;
    }
    return affected;
  }
}
