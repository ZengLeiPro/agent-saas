/**
 * §3.6 组织目录快照与变更流的消费端。
 *
 * 消费算法：首次或 410 → 逐页拉快照（所有页 `snapshotSeq` 必须一致，否则整份重拉）
 * → 单一本地事务应用 → `checkpoint = snapshotSeq`；之后 `changes?after=checkpoint`，
 * `seq ≤ checkpoint` 忽略，每批事务提交后 `checkpoint = nextSeq`；
 * 限速每租户每分钟 ≤ 60 次；服务凭据走 `Authorization: Bearer`。
 */
import {
  validateDirectoryChanges,
  validateDirectoryGone,
  validateDirectorySnapshot,
  type DirectoryEvent,
  type DirectoryGroup,
  type DirectorySnapshot,
  type DirectoryUser,
} from '@kaiyan/ky-app-contract';

import type { KyAppConfig } from '../config/index.js';
import { KyAppError } from '../errors.js';
import type { FetchLike } from '../jwks/client.js';
import type { DirectoryStore } from './store.js';
import { directoryStalenessGate, type DirectoryStalenessGate } from './staleness.js';

/** 每租户每分钟最多 60 次目录请求（§3.6）。 */
export const DIRECTORY_RATE_LIMIT = { max: 60, windowMs: 60_000 } as const;
/** 变更流单批上限（§3.6 `limit=500`）。 */
export const DIRECTORY_CHANGES_LIMIT = 500;
/** 快照分页的安全上限，防止服务端 `pageToken` 成环。 */
export const DIRECTORY_SNAPSHOT_MAX_PAGES = 1000;

export type DirectorySyncStatus = 'snapshot' | 'changes' | 'up-to-date' | 'rate_limited';

export interface DirectorySyncResult {
  status: DirectorySyncStatus;
  /** 本轮应用的事件数（快照模式下为用户 + 分组数）。 */
  applied: number;
  checkpoint: number | null;
  /** 快照模式下是否由 410 触发。 */
  resnapshot?: boolean;
}

export interface DirectoryClientOptions {
  config: KyAppConfig;
  store: DirectoryStore;
  /** KY Agent 的 API 基址，例如 `https://api.agent.kaiyan.net`。 */
  baseUrl: string;
  fetch?: FetchLike;
  now?: () => number;
}

export interface DirectoryClient {
  /** 跑一轮同步。 */
  sync(): Promise<DirectorySyncResult>;
  /** 服务凭据签发后 24 小时内必须确认（§3.6）。 */
  ackCredential(): Promise<void>;
  /** 当前陈旧度与三级门禁。 */
  staleness(): Promise<DirectoryStalenessGate>;
  /** SAT `tadm` 覆盖通道（§3.4 双通道同步）。 */
  applySatTenantAdmin(userId: string, tadm: boolean): Promise<void>;
}

class WindowLimiter {
  private hits: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  take(nowMs: number): boolean {
    this.hits = this.hits.filter((at) => nowMs - at < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(nowMs);
    return true;
  }
}

class DirectoryGoneError extends Error {
  constructor(readonly code: 'snapshot_expired' | 'cursor_expired') {
    super(code);
    this.name = 'DirectoryGoneError';
  }
}

export function createDirectoryClient(options: DirectoryClientOptions): DirectoryClient {
  const now = options.now ?? Date.now;
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const limiter = new WindowLimiter(DIRECTORY_RATE_LIMIT.max, DIRECTORY_RATE_LIMIT.windowMs);
  const base = options.baseUrl.replace(/\/+$/u, '');

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!limiter.take(now())) {
      throw new KyAppError('rate_limited', { message: '目录接口本地限速（每分钟 60 次）' });
    }
    const response = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${options.config.serviceCredential}`,
        accept: 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (response.status === 410) {
      const body: unknown = await response.json();
      const check = validateDirectoryGone(body);
      if (!check.ok)
        throw new KyAppError('internal', {
          message: `410 响应不合附录 L：${check.errors.join('；')}`,
        });
      throw new DirectoryGoneError((body as { code: 'snapshot_expired' | 'cursor_expired' }).code);
    }
    if (!response.ok) {
      throw new KyAppError('upstream_unavailable', {
        message: `目录接口返回 ${response.status}`,
      });
    }
    if (response.status === 204) return null;
    return response.json();
  }

  /** 逐页拉整份快照；任一页 `snapshotSeq` 不一致即整份重拉（最多重试一次）。 */
  async function fetchSnapshot(): Promise<{
    snapshotSeq: number;
    users: DirectoryUser[];
    groups: DirectoryGroup[];
  }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const users: DirectoryUser[] = [];
      const groups: DirectoryGroup[] = [];
      let pageToken: string | undefined;
      let snapshotSeq: number | null = null;
      let inconsistent = false;

      for (let page = 0; page < DIRECTORY_SNAPSHOT_MAX_PAGES; page += 1) {
        const query = pageToken === undefined ? '' : `?pageToken=${encodeURIComponent(pageToken)}`;
        const body = await request(`/api/app-contract/v1/directory/snapshot${query}`);
        const check = validateDirectorySnapshot(body);
        if (!check.ok) {
          throw new KyAppError('internal', {
            message: `快照不合附录 L：${check.errors.join('；')}`,
          });
        }
        const snapshot = body as DirectorySnapshot;
        if (snapshotSeq === null) snapshotSeq = snapshot.snapshotSeq;
        else if (snapshotSeq !== snapshot.snapshotSeq) {
          inconsistent = true;
          break;
        }
        users.push(...snapshot.users);
        groups.push(...snapshot.groups);
        pageToken = snapshot.pageToken;
        if (pageToken === undefined) break;
      }

      if (inconsistent) continue;
      if (snapshotSeq === null) throw new KyAppError('internal', { message: '快照没有返回任何页' });
      if (pageToken !== undefined) {
        throw new KyAppError('internal', { message: '快照分页超过上限，疑似 pageToken 成环' });
      }
      return { snapshotSeq, users, groups };
    }
    throw new KyAppError('upstream_unavailable', {
      message: '快照各页 snapshotSeq 不一致，重拉后仍不一致',
    });
  }

  async function applySnapshot(resnapshot: boolean): Promise<DirectorySyncResult> {
    const snapshot = await fetchSnapshot();
    const at = now();
    await options.store.applySnapshot({ ...snapshot, at });
    return {
      status: 'snapshot',
      applied: snapshot.users.length + snapshot.groups.length,
      checkpoint: snapshot.snapshotSeq,
      resnapshot,
    };
  }

  async function applyChanges(checkpoint: number): Promise<DirectorySyncResult> {
    let cursor = checkpoint;
    let applied = 0;

    for (;;) {
      const body = await request(
        `/api/app-contract/v1/directory/changes?after=${cursor}&limit=${DIRECTORY_CHANGES_LIMIT}`,
      );
      const check = validateDirectoryChanges(body);
      if (!check.ok) {
        throw new KyAppError('internal', {
          message: `变更流不合附录 L：${check.errors.join('；')}`,
        });
      }
      const changes = body as { events: DirectoryEvent[]; nextSeq: number; hasMore: boolean };
      await options.store.applyChanges({
        events: changes.events,
        nextSeq: changes.nextSeq,
        at: now(),
      });
      applied += changes.events.length;
      cursor = changes.nextSeq;
      if (!changes.hasMore) break;
    }

    // applyChanges 已把 checkpoint 的时间刷新到本轮，无需再 touch。
    return {
      status: applied === 0 ? 'up-to-date' : 'changes',
      applied,
      checkpoint: cursor,
    };
  }

  return {
    async sync(): Promise<DirectorySyncResult> {
      const checkpoint = await options.store.getCheckpoint();
      try {
        if (checkpoint === null) return await applySnapshot(false);
        return await applyChanges(checkpoint.seq);
      } catch (error) {
        if (error instanceof DirectoryGoneError) {
          // snapshot_expired / cursor_expired 都要求整份重拉（§3.6）。
          return applySnapshot(true);
        }
        if (error instanceof KyAppError && error.code === 'rate_limited') {
          return { status: 'rate_limited', applied: 0, checkpoint: checkpoint?.seq ?? null };
        }
        throw error;
      }
    },

    async ackCredential(): Promise<void> {
      await request(
        `/api/app-contract/v1/installations/${encodeURIComponent(options.config.installationId)}/credential-ack`,
        { method: 'POST' },
      );
    },

    async staleness(): Promise<DirectoryStalenessGate> {
      const checkpoint = await options.store.getCheckpoint();
      if (checkpoint === null) return directoryStalenessGate(Number.POSITIVE_INFINITY);
      return directoryStalenessGate((now() - checkpoint.at) / 1000);
    },

    async applySatTenantAdmin(userId: string, tadm: boolean): Promise<void> {
      await options.store.setTenantAdmin(userId, tadm, now());
    },
  };
}
