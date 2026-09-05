/**
 * mock 目录服务（附录 L / §3.6）：快照分页、变更流、410、`credential-ack`。
 *
 * 只实现被测项目消费端需要的三个端点，形状严格按附录 L；一致性测试通过
 * `setSnapshot` / `pushEvents` / `expireCursor` 等方法驱动状态。
 */
import type { DirectoryEvent, DirectoryGroup, DirectoryUser } from '@kaiyan/ky-app-contract';

/** 分发式 Omit：`DirectoryEvent` 是判别联合，直接 `Omit` 会把各分支的独有字段吃掉。 */
type WithoutSeq<T> = T extends unknown ? Omit<T, 'seq'> : never;
export type DirectoryEventInput = WithoutSeq<DirectoryEvent>;

export interface MockDirectoryOptions {
  /** 服务凭据（`Authorization: Bearer`），与被测项目的 `KY_SERVICE_CREDENTIAL` 一致。 */
  serviceCredential: string;
  installationId: string;
  /** 快照每页用户数，默认 2（保证一致性测试一定会分页）。 */
  pageSize?: number;
}

export interface MockDirectory {
  /** 命中目录路由则返回响应，否则返回 null（交给壳的其他路由）。 */
  handle(request: Request): Promise<Response | null>;
  /** 整份替换快照并把 `snapshotSeq` 设为给定值。 */
  setSnapshot(input: {
    snapshotSeq: number;
    users: DirectoryUser[];
    groups: DirectoryGroup[];
  }): void;
  /** 追加变更事件；`seq` 由服务端自增。返回本批最后的 seq。 */
  pushEvents(events: DirectoryEventInput[]): number;
  /** 下一次 `changes` 返回 410 `cursor_expired`。 */
  expireCursor(): void;
  /** 下一次 `snapshot` 返回 410 `snapshot_expired`。 */
  expireSnapshot(): void;
  /**
   * 下一次 `changes` 无视 `after`，从 `seq` 开始重发（模拟服务端重放）。
   * 用于验证消费端「`seq ≤ checkpoint` 忽略」的幂等性。
   */
  replayNextChangesFrom(seq: number): void;
  /** 是否已收到 `credential-ack`。 */
  credentialAcked(): boolean;
  /** 请求日志（路径 + 查询），供断言分页与续流。 */
  readonly calls: string[];
  currentSeq(): number;
}

const BASE = '/api/app-contract/v1';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function createMockDirectory(options: MockDirectoryOptions): MockDirectory {
  const pageSize = options.pageSize ?? 2;
  let users: DirectoryUser[] = [];
  let groups: DirectoryGroup[] = [];
  let snapshotSeq = 0;
  let seq = 0;
  let events: DirectoryEvent[] = [];
  let goneOnChanges: 'cursor_expired' | null = null;
  let goneOnSnapshot: 'snapshot_expired' | null = null;
  let replayFrom: number | null = null;
  let acked = false;
  const calls: string[] = [];

  function snapshotPage(pageToken: string | null): Response {
    const index = pageToken === null ? 0 : Number.parseInt(pageToken, 10);
    if (!Number.isInteger(index) || index < 0) return json({ code: 'cursor_expired' }, 410);
    const start = index * pageSize;
    const slice = users.slice(start, start + pageSize);
    const hasMore = start + pageSize < users.length;
    const body: Record<string, unknown> = {
      snapshotSeq,
      // 分组只在第一页给全量，用户逐页给（附录 L 允许两个数组各自为空）。
      users: slice,
      groups: index === 0 ? groups : [],
    };
    if (hasMore) body.pageToken = String(index + 1);
    return json(body);
  }

  function changesPage(after: number, limit: number): Response {
    const floor = replayFrom === null ? after : Math.min(after, replayFrom - 1);
    replayFrom = null;
    const pending = events.filter((event) => event.seq > floor);
    const batch = pending.slice(0, limit);
    const nextSeq = batch.length === 0 ? after : Math.max(after, batch[batch.length - 1].seq);
    return json({ events: batch, nextSeq, hasMore: pending.length > batch.length });
  }

  return {
    calls,
    currentSeq: () => seq,
    credentialAcked: () => acked,

    setSnapshot(input) {
      users = [...input.users];
      groups = [...input.groups];
      snapshotSeq = input.snapshotSeq;
      seq = Math.max(seq, input.snapshotSeq);
      // 快照重置后旧事件不再有意义（服务端的历史窗口）。
      events = events.filter((event) => event.seq > input.snapshotSeq);
    },

    pushEvents(batch) {
      for (const event of batch) {
        seq += 1;
        events.push({ ...event, seq } as DirectoryEvent);
      }
      return seq;
    },

    expireCursor() {
      goneOnChanges = 'cursor_expired';
    },

    expireSnapshot() {
      goneOnSnapshot = 'snapshot_expired';
    },

    replayNextChangesFrom(seq) {
      replayFrom = seq;
    },

    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(BASE)) return null;
      calls.push(`${url.pathname}${url.search}`);

      const authorization = request.headers.get('authorization');
      if (authorization !== `Bearer ${options.serviceCredential}`) {
        return json({ ok: false, error: { code: 'unauthorized' } }, 401);
      }

      if (url.pathname === `${BASE}/directory/snapshot`) {
        if (goneOnSnapshot !== null) {
          const code = goneOnSnapshot;
          goneOnSnapshot = null;
          return json({ code }, 410);
        }
        return snapshotPage(url.searchParams.get('pageToken'));
      }

      if (url.pathname === `${BASE}/directory/changes`) {
        if (goneOnChanges !== null) {
          const code = goneOnChanges;
          goneOnChanges = null;
          return json({ code }, 410);
        }
        const after = Number.parseInt(url.searchParams.get('after') ?? '0', 10);
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '500', 10);
        return changesPage(
          Number.isFinite(after) ? after : 0,
          Number.isFinite(limit) ? limit : 500,
        );
      }

      if (
        request.method === 'POST' &&
        url.pathname ===
          `${BASE}/installations/${encodeURIComponent(options.installationId)}/credential-ack`
      ) {
        acked = true;
        return json({ ok: true });
      }

      return json({ ok: false, error: { code: 'not_found' } }, 404);
    },
  };
}
