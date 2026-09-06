/**
 * WP2b 组织目录快照与变更流的两个端点（规范 §3.6、附录 L）。
 *
 * ```
 * GET /api/app-contract/v1/directory/snapshot?pageToken=
 * GET /api/app-contract/v1/directory/changes?after=<seq>&limit=500
 * ```
 *
 * 四条与别处不同的地方：
 *
 * 1. **鉴权是服务凭据 Bearer，不是会话 JWT**（与 `credential-ack` 同款），
 *    因此两条路径要登记进 `auth/publicRoutes.ts`——那里的「public」指的是
 *    「不经会话中间件」，鉴权在本 router 内按 scope 完成，一点都没放宽。
 * 2. **组织 id 绝不从请求里取**。链路写死为
 *    `凭据 → credential.installationId → installation.tenantId`，
 *    调用方无法通过任何参数指向别的组织（锚点地图 A4 的越权防线）。
 * 3. **410 的响应体是附录 L 的 `{code, requestId?}`，不是附录 D 的
 *    `{ok:false, error:{...}}`**。消费端 `client.ts:104-112` 对 410 走
 *    `validateDirectoryGone` 严格校验，套附录 D 的壳会被判红。因此本文件
 *    有一个独立的 410 出口 `sendDirectoryGone`，其余错误仍走 `sendKyAppError`。
 * 4. **限速在鉴权之后、业务之前**，按组织计（§3.6 每租户每分钟 ≤ 60）。
 */
import { Router } from 'express';

import type { KyAppCredentialScope } from '../installations/credentialStore.js';
import type { KyAppCredentialManager } from '../installations/credentials.js';
import type { KyAppInstallation } from '../systems/types.js';
import {
  DIRECTORY_CHANGES_MAX_LIMIT,
  type ListDirectoryChangesResult,
} from '../directory/changeLog.js';
import {
  DirectoryPageTokenError,
  signDirectoryPageToken,
  verifyDirectoryPageToken,
  type DirectoryPageTokenKeyMaterial,
} from '../directory/pageToken.js';
import { DirectoryRateLimiter } from '../directory/rateLimit.js';
import {
  DIRECTORY_SNAPSHOT_PAGE_SIZE,
  type DirectorySnapshotSource,
} from '../directory/snapshot.js';
import { toDirectoryEvent } from '../directory/types.js';
import { requestIdOf, sendKyAppError, sendKyAppFailure } from './support.js';
import type { Request, Response } from 'express';

/** 附录 L `error410.code`。 */
export type DirectoryGoneCode = 'snapshot_expired' | 'cursor_expired';

/** 变更日志的读取面；`PgKyAppDirectoryChangeLog` 结构上即满足。 */
export interface DirectoryChangeReader {
  listAfter(input: {
    tenantId: string;
    afterSeq: number;
    limit?: number;
  }): Promise<ListDirectoryChangesResult>;
  /** 仍在库里的最小 seq 减一；`after` 小于它说明中间已被 30 天清理删掉。 */
  retentionFloorSeq(tenantId: string): Promise<number>;
}

export interface KyAppDirectoryRouterOptions {
  credentials: KyAppCredentialManager;
  /** 按 iid 取安装实例；只用它的 `tenantId` 与 `status`。 */
  getInstallation(installationId: string): Promise<KyAppInstallation | null>;
  snapshots: DirectorySnapshotSource;
  changes: DirectoryChangeReader;
  now?: () => number;
  /** 测试注入：把页大小调小以逼出分页。 */
  pageSize?: number;
  limiter?: DirectoryRateLimiter;
}

interface AuthorizedCaller {
  tenantId: string;
  installationId: string;
}

/** 附录 L 的 410 体。**刻意不复用 `sendKyAppError`**（形态不同，见文件头第 3 条）。 */
function sendDirectoryGone(req: Request, res: Response, code: DirectoryGoneCode): void {
  res.status(410).json({ code, requestId: requestIdOf(req) });
}

/** `after` / `limit` 的解析：缺省合法、越界收敛、非法即 400。 */
function parseNonNegativeInt(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string') return null;
  if (!/^\d{1,15}$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function createKyAppDirectoryRouter(options: KyAppDirectoryRouterOptions): Router {
  const router = Router();
  const now = options.now ?? Date.now;
  const pageSize = Math.max(1, options.pageSize ?? DIRECTORY_SNAPSHOT_PAGE_SIZE);
  const limiter = options.limiter ?? new DirectoryRateLimiter();

  /**
   * 鉴权 + 组织解析 + 限速。任何一步失败都自己写完响应并返回 `null`，
   * 调用方只要 `if (!caller) return;`。
   */
  async function authorize(
    req: Request,
    res: Response,
    scope: KyAppCredentialScope,
  ): Promise<AuthorizedCaller | null> {
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token === '') {
      sendKyAppError(req, res, 'unauthorized', '缺少服务凭据');
      return null;
    }
    const record = await options.credentials.authenticate(token, scope);
    if (!record) {
      // 不区分「凭据不存在」「已过期」「缺 scope」，避免成为凭据探测口。
      sendKyAppError(req, res, 'unauthorized', '服务凭据无效或缺少所需 scope');
      return null;
    }
    const installation = await options.getInstallation(record.installationId);
    if (!installation) {
      sendKyAppError(req, res, 'unauthorized', '服务凭据无效或缺少所需 scope');
      return null;
    }
    // §3.7：停用 / 删除的实例除 events / health 外一律拒绝。
    // `pending` 放行：定制项目常常要先把组织目录同步好再由平台切到 enabled。
    if (installation.status === 'disabled' || installation.status === 'deleted') {
      sendKyAppError(req, res, 'installation_disabled', '安装实例已停用');
      return null;
    }
    const decision = limiter.take(installation.tenantId, now());
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      sendKyAppError(req, res, 'rate_limited', '目录接口每分钟最多 60 次');
      return null;
    }
    return { tenantId: installation.tenantId, installationId: record.installationId };
  }

  /**
   * 该实例可用于 pageToken 签验的密钥。`getInstallationKeys` 按 `created_at DESC`
   * 排序，因此第 0 把是 current；即便将来排序变了也只影响「用哪把签」——
   * 验签侧逐把试，10 分钟 TTL 内不会因为一次轮换而失效。
   */
  async function pageTokenKeys(installationId: string): Promise<DirectoryPageTokenKeyMaterial[]> {
    return options.credentials.listAcceptableInstallationKeys(installationId);
  }

  router.get('/directory/snapshot', async (req, res) => {
    const caller = await authorize(req, res, 'snapshot');
    if (!caller) return;
    try {
      const raw = req.query.pageToken;
      if (raw !== undefined && typeof raw !== 'string') {
        return sendKyAppError(req, res, 'invalid_input', 'pageToken 非法');
      }
      const keys = await pageTokenKeys(caller.installationId);
      let page = 0;
      let expectedSeq: number | null = null;
      if (raw !== undefined && raw !== '') {
        try {
          const claims = verifyDirectoryPageToken({ token: raw, keys, nowMs: now() });
          // token 是按实例密钥签的，理论上不可能串组织；这里再挡一层。
          if (claims.tid !== caller.tenantId) {
            return sendDirectoryGone(req, res, 'snapshot_expired');
          }
          page = claims.page;
          expectedSeq = claims.seq;
        } catch (error) {
          if (error instanceof DirectoryPageTokenError) {
            return sendDirectoryGone(req, res, 'snapshot_expired');
          }
          throw error;
        }
      }

      const result = await options.snapshots.readPage({
        tenantId: caller.tenantId,
        page,
        pageSize,
      });
      // §3.6：所有页 `snapshotSeq` 必须相同，不一致即整份重拉。
      if (expectedSeq !== null && result.snapshotSeq !== expectedSeq) {
        return sendDirectoryGone(req, res, 'snapshot_expired');
      }

      const body: {
        snapshotSeq: number;
        pageToken?: string;
        users: unknown[];
        groups: unknown[];
      } = {
        snapshotSeq: result.snapshotSeq,
        users: result.users,
        groups: result.groups,
      };
      if (result.hasMore) {
        const signingKey = keys[0];
        if (!signingKey) {
          // 没有安装密钥就发不出下一页的游标；宁可让消费端整份重拉，也不返回残页。
          return sendDirectoryGone(req, res, 'snapshot_expired');
        }
        body.pageToken = signDirectoryPageToken({
          tid: caller.tenantId,
          seq: result.snapshotSeq,
          page: page + 1,
          nowMs: now(),
          key: signingKey,
        });
      }
      res.setHeader('cache-control', 'no-store');
      res.json(body);
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  router.get('/directory/changes', async (req, res) => {
    const caller = await authorize(req, res, 'changes');
    if (!caller) return;
    try {
      const after = parseNonNegativeInt(req.query.after, 0);
      const rawLimit = parseNonNegativeInt(req.query.limit, DIRECTORY_CHANGES_MAX_LIMIT);
      if (after === null || rawLimit === null || rawLimit < 1) {
        return sendKyAppError(req, res, 'invalid_input', 'after 或 limit 非法');
      }
      const limit = Math.min(rawLimit, DIRECTORY_CHANGES_MAX_LIMIT);

      // §3.6：`after` 早于 30 天保留期下界 → 410 `cursor_expired`（重拉快照）。
      const floor = await options.changes.retentionFloorSeq(caller.tenantId);
      if (after < floor) return sendDirectoryGone(req, res, 'cursor_expired');

      const result = await options.changes.listAfter({
        tenantId: caller.tenantId,
        afterSeq: after,
        limit,
      });
      res.setHeader('cache-control', 'no-store');
      res.json({
        events: result.records.map(toDirectoryEvent),
        nextSeq: result.nextSeq,
        hasMore: result.hasMore,
      });
    } catch (error) {
      sendKyAppFailure(req, res, error);
    }
  });

  return router;
}
