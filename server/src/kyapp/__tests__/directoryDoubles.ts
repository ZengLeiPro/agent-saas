/**
 * WP2b 目录变更日志的内存替身。
 *
 * **只在测试里用**，但语义必须与 `directory/changeLog.ts` 的 PG 实现逐条对齐，
 * 否则路由测试与 `DirectoryClient` 交叉测试证明的是替身而不是产品：
 * - `seq` 是**全局**单调（不按组织分段），与 `BIGSERIAL` 一致；
 * - `listAfter` 只返回本组织 `seq > afterSeq` 的事件，多取一条判 `hasMore`；
 * - 无事件时 `nextSeq` 停在 `afterSeq` 不动（附录 L 的 `nextSeq` 语义）；
 * - `retentionFloorSeq` = 本组织仍在库里的最小 `seq` 减一，库里没有则 0。
 *
 * 放在 `__tests__/` 而不是 `directory/changeLog.ts` 里，是因为 `changeLog.ts` 已被
 * `config/release-migration-reviews.json` 的 17 条生产基线逐字节收录，
 * 动它一行就要重算全部 17 条摘要（偏差 `2B-A-07`）——为一个测试替身不值得。
 */
import type {
  AppendDirectoryChangeInput,
  ListDirectoryChangesResult,
} from '../directory/changeLog.js';
import { DIRECTORY_CHANGES_MAX_LIMIT } from '../directory/changeLog.js';
import type { DirectoryChangeRecord } from '../directory/types.js';

export class MemoryDirectoryChangeLog {
  private readonly records: DirectoryChangeRecord[] = [];
  private nextSequence = 1;

  /** 追加一批事件，返回落库结果（`eventId` 重复即幂等跳过，与 PG 的 ON CONFLICT 一致）。 */
  append(inputs: readonly AppendDirectoryChangeInput[]): DirectoryChangeRecord[] {
    const appended: DirectoryChangeRecord[] = [];
    for (const input of inputs) {
      const eventId = input.eventId ?? `evt-${String(this.nextSequence)}`;
      if (this.records.some((record) => record.eventId === eventId)) continue;
      const record: DirectoryChangeRecord = {
        seq: this.nextSequence,
        eventId,
        tenantId: input.tenantId,
        source: input.source,
        type: input.type,
        entityId: input.entityId,
        payload: input.payload ?? {},
        occurredAt: (input.occurredAt ?? new Date()).toISOString(),
      };
      this.nextSequence += 1;
      this.records.push(record);
      appended.push(record);
    }
    return appended;
  }

  /** 模拟 30 天保留清理：删掉 `seq <= seq` 的行，`seq` 序列本身不重排。 */
  purgeUpTo(seq: number): number {
    let removed = 0;
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      if (this.records[index]!.seq <= seq) {
        this.records.splice(index, 1);
        removed += 1;
      }
    }
    return removed;
  }

  async listAfter(input: {
    tenantId: string;
    afterSeq: number;
    limit?: number;
  }): Promise<ListDirectoryChangesResult> {
    const limit = Math.min(
      Math.max(input.limit ?? DIRECTORY_CHANGES_MAX_LIMIT, 1),
      DIRECTORY_CHANGES_MAX_LIMIT,
    );
    const pending = this.records
      .filter((record) => record.tenantId === input.tenantId && record.seq > input.afterSeq)
      .sort((left, right) => left.seq - right.seq);
    const hasMore = pending.length > limit;
    const records = pending.slice(0, limit);
    const last = records[records.length - 1];
    return { records, nextSeq: last ? last.seq : input.afterSeq, hasMore };
  }

  async retentionFloorSeq(tenantId: string): Promise<number> {
    const seqs = this.records
      .filter((record) => record.tenantId === tenantId)
      .map((record) => record.seq);
    return seqs.length === 0 ? 0 : Math.min(...seqs) - 1;
  }

  async latestSeq(tenantId: string): Promise<number> {
    const seqs = this.records
      .filter((record) => record.tenantId === tenantId)
      .map((record) => record.seq);
    return seqs.length === 0 ? 0 : Math.max(...seqs);
  }
}
