import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ToolInvocationResponse } from 'server/runtime/handProtocol.js';

/**
 * Durable Tool Invocation store（TASK-316）。
 *
 * Hand 重启后内存 `Map` 里的 invocation、cancel controller 与 result 全部丢失，
 * Brain 只能拿到 404，无法判断先前工具调用究竟完成、失败还是仍有副作用。
 * 本模块把 invocation 状态按 invocationId 落到 hand 本地磁盘（原子写：tmp + rename），
 * 让 Hand 变成"重启透明"：
 * - 终态结果跨重启可查（GET /invocations/:id 结果对账）；
 * - 重复派发同一 invocationId 时重放已持久化的结果（幂等），不再二次执行副作用；
 * - DELETE cancel 的 tombstone 跨重启保留，重启后 cancel-before-start 语义不丢；
 * - 启动时把上一进程遗留的 running 记录对账为"interrupted/indeterminate"终态，
 *   向 Brain 如实暴露副作用不确定性，而不是装作没发生过。
 *
 * 形态与主服务 PG tool_invocations 表对齐（状态语义 running/completed/cancelled），
 * 但 Hand 是独立部署的进程，不依赖 brain 的 PG；磁盘 journal 就是它的"外置状态"。
 */

export type StoredInvocationState = 'running' | 'completed' | 'cancelled';

export interface StoredInvocationRecord {
  invocationId: string;
  state: StoredInvocationState;
  createdAt: string;
  updatedAt: string;
  /** 终态结果；cancel tombstone（尚未有结果）时缺省。 */
  response?: ToolInvocationResponse;
  /** DELETE cancel 落盘时间；完成后保留，用于结果对账时区分取消路径。 */
  cancelledAt?: string;
  /** 启动对账时标记：上一进程重启打断的 invocation。 */
  interruptedAt?: string;
  /** Real provider attempt that created this journal record; never an idempotency key. */
  executionAttemptId?: string;
}

export type RegisterRunningOutcome =
  | { outcome: 'created'; record: StoredInvocationRecord }
  /** 既有记录仍处 running（通常是异常场景：另一个 hand 进程或对账失败）。 */
  | { outcome: 'already_running'; record: StoredInvocationRecord }
  /** 既有 cancel tombstone：调用方应拒绝执行（cancelled before start）。 */
  | { outcome: 'cancelled_tombstone'; record: StoredInvocationRecord }
  /** 既有终态结果：调用方应重放结果而不是二次执行。 */
  | { outcome: 'replay'; record: StoredInvocationRecord };

export interface HandInvocationStore {
  /** 登记开始执行；已存在时返回既有记录，不覆盖。 */
  registerRunning(invocationId: string, attemptId?: string): Promise<RegisterRunningOutcome>;
  get(invocationId: string): Promise<StoredInvocationRecord | undefined>;
  /** 幂等写终态结果；首个终态胜出（后续 complete 不覆盖）。 */
  complete(
    invocationId: string,
    response: ToolInvocationResponse,
  ): Promise<StoredInvocationRecord | undefined>;
  /** 幂等写 cancel tombstone；已有终态结果时不动。 */
  markCancelled(invocationId: string): Promise<StoredInvocationRecord | undefined>;
  /** 启动对账：上一进程遗留 running -> interrupted 终态。 */
  reconcileStartup(): Promise<{ loaded: number; interrupted: number }>;
  /** 按 mtime 清理过期记录。 */
  sweep(now?: Date): Promise<{ deleted: number }>;
}

const FILENAME_MAX_LENGTH = 200;
const SWEEP_DEFAULT_RETENTION_MS = 24 * 60 * 60_000;

function invocationFileName(invocationId: string): string {
  const encoded = encodeURIComponent(invocationId);
  if (encoded.length <= FILENAME_MAX_LENGTH && !encoded.includes('/')) return `${encoded}.json`;
  // 超长/特殊 id 退化为哈希名；invocationId 本体仍在记录内部，可读性不受影响。
  return `h-${createHash('sha256').update(invocationId).digest('hex').slice(0, 40)}.json`;
}

function interruptedResponse(interruptedAt: string): ToolInvocationResponse {
  return {
    status: 'error',
    error:
      'hand-server restarted while invocation was running; result is indeterminate and side effects may have partially applied',
    metadata: { interrupted: true, indeterminate: true, interruptedAt },
  };
}

/**
 * 磁盘 journal 实现。每个 invocation 一个 JSON 文件；写入全部走 tmp + rename 原子替换。
 * 单 hand 进程独占目录，进程内不额外加锁（handlers 层的内存 invocations Map 先做 single-flight）。
 */
export class FileHandInvocationStore implements HandInvocationStore {
  private readonly dir: string;
  private readonly retentionMs: number;
  private writeSeq = 0;
  /**
   * 单 invocationId 的写串行化（TASK-316 返工）：complete 与 markCancelled 都是
   * read-modify-rename，无锁并发时后写会基于旧 running 记录覆盖前写，
   * 已完成的 response 会被迟到 cancel 的 tombstone 整体抹掉。
   * 进程内按 id 排队所有状态变更，保证任意交错下首个终态及其数据不丢。
   */
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(dir: string, options?: { retentionMs?: number }) {
    this.dir = dir;
    this.retentionMs = options?.retentionMs ?? SWEEP_DEFAULT_RETENTION_MS;
  }

  /** 按 invocationId 串行执行 journal 变更；前序失败不阻塞后续（各自独立落盘）。 */
  private withMutationLock<T>(invocationId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(invocationId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.mutations.set(invocationId, run);
    run
      .finally(() => {
        if (this.mutations.get(invocationId) === run) this.mutations.delete(invocationId);
      })
      .catch(() => {});
    return run;
  }

  async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private fileFor(invocationId: string): string {
    return join(this.dir, invocationFileName(invocationId));
  }

  private async readRecord(invocationId: string): Promise<StoredInvocationRecord | undefined> {
    try {
      const raw = await readFile(this.fileFor(invocationId), 'utf-8');
      const parsed = JSON.parse(raw) as StoredInvocationRecord;
      if (!parsed || parsed.invocationId !== invocationId || typeof parsed.state !== 'string')
        return undefined;
      return parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  private async atomicWrite(record: StoredInvocationRecord): Promise<void> {
    const target = this.fileFor(record.invocationId);
    const tmp = `${target}.tmp-${process.pid}-${(this.writeSeq += 1)}`;
    await writeFile(tmp, `${JSON.stringify(record)}\n`, 'utf-8');
    await rename(tmp, target);
  }

  async registerRunning(invocationId: string, attemptId?: string): Promise<RegisterRunningOutcome> {
    return await this.withMutationLock(invocationId, async () => {
      const existing = await this.readRecord(invocationId);
      if (existing) {
        if (existing.response) return { outcome: 'replay', record: existing };
        if (existing.state === 'cancelled')
          return { outcome: 'cancelled_tombstone', record: existing };
        return { outcome: 'already_running', record: existing };
      }
      const now = new Date().toISOString();
      const record: StoredInvocationRecord = {
        invocationId,
        state: 'running',
        createdAt: now,
        updatedAt: now,
        ...(attemptId ? { executionAttemptId: attemptId } : {}),
      };
      await this.atomicWrite(record);
      return { outcome: 'created', record };
    });
  }

  async get(invocationId: string): Promise<StoredInvocationRecord | undefined> {
    return await this.readRecord(invocationId);
  }

  async complete(
    invocationId: string,
    response: ToolInvocationResponse,
  ): Promise<StoredInvocationRecord | undefined> {
    return await this.withMutationLock(invocationId, async () => {
      const existing = await this.readRecord(invocationId);
      const now = new Date().toISOString();
      // 首个终态胜出：重复 complete（如 cancel 后 execute 收尾又落一次）不覆盖结果。
      if (existing) {
        if (existing.response) return existing;
        // state 一并转 completed；cancelledAt 等历史字段保留，供结果对账区分取消路径。
        return await this.writeTerminal(existing, { state: 'completed', response, updatedAt: now });
      }
      const record: StoredInvocationRecord = {
        invocationId,
        state: 'completed',
        createdAt: now,
        updatedAt: now,
        response,
      };
      await this.atomicWrite(record);
      return record;
    });
  }

  async markCancelled(invocationId: string): Promise<StoredInvocationRecord | undefined> {
    return await this.withMutationLock(invocationId, async () => {
      const existing = await this.readRecord(invocationId);
      const now = new Date().toISOString();
      if (existing) {
        // 已有终态结果：cancel 迟到时不覆盖（invocation 已完成，无需 tombstone）。
        if (existing.cancelledAt || existing.response) return existing;
        return await this.writeTerminal(existing, {
          state: 'cancelled',
          cancelledAt: now,
          updatedAt: now,
        });
      }
      const record: StoredInvocationRecord = {
        invocationId,
        state: 'cancelled',
        createdAt: now,
        updatedAt: now,
        cancelledAt: now,
      };
      await this.atomicWrite(record);
      return record;
    });
  }

  private async writeTerminal(
    existing: StoredInvocationRecord,
    patch: Partial<StoredInvocationRecord>,
  ): Promise<StoredInvocationRecord> {
    const next: StoredInvocationRecord = { ...existing, ...patch };
    await this.atomicWrite(next);
    return next;
  }

  async reconcileStartup(): Promise<{ loaded: number; interrupted: number }> {
    let loaded = 0;
    let interrupted = 0;
    for (const file of await this.listFiles()) {
      let record: StoredInvocationRecord | undefined;
      try {
        record = JSON.parse(
          await readFile(join(this.dir, file), 'utf-8'),
        ) as StoredInvocationRecord;
      } catch {
        continue; // 损坏文件跳过，交给 sweep 按 mtime 清理
      }
      if (!record || typeof record.invocationId !== 'string') continue;
      loaded += 1;
      if (record.state === 'running' && !record.response) {
        const interruptedAt = new Date().toISOString();
        await this.writeTerminal(record, {
          state: 'completed',
          response: interruptedResponse(interruptedAt),
          interruptedAt,
          updatedAt: interruptedAt,
        });
        interrupted += 1;
      }
    }
    return { loaded, interrupted };
  }

  async sweep(now = new Date()): Promise<{ deleted: number }> {
    let deleted = 0;
    const cutoff = now.getTime() - this.retentionMs;
    for (const file of await this.listFiles()) {
      const full = join(this.dir, file);
      try {
        const stats = await stat(full);
        if (stats.mtimeMs < cutoff) {
          await unlink(full);
          deleted += 1;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return { deleted };
  }

  private async listFiles(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
  }
}

export { interruptedResponse };
