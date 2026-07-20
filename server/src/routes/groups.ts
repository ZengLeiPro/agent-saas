/**
 * Groups API 路由
 */
import { Router } from "express";
import type { Request, Response } from "express";
import * as fs from "node:fs/promises";
import type { GroupStore } from "../data/groups/index.js";
import type { UserStore } from "../data/users/store.js";
import { resolveUserCwd } from "../workspace/resolver.js";
import {
  findTranscriptOrMetaPathBySessionId,
  getTranscriptPath,
} from "../data/transcripts/store.js";
import { readSessionMeta } from "../data/transcripts/meta.js";
import { summarizeTranscript } from "../data/transcripts/parse.js";
import { auditLog } from "../data/login-logs/index.js";
import type { EventBus } from "../channels/web/eventBus.js";
import type { AgentStore } from "../data/agents/store.js";
import type { AgentProfileInfo } from "../data/agents/types.js";
import { hidesMemoryPollFrom } from "../data/sessions/access.js";
import { isMemoryPollJob } from "../cron/memoryPoll.js";

type SessionAgent = Pick<
  AgentProfileInfo,
  "username" | "name" | "signature" | "avatar" | "avatarVersion"
>;

function getUserId(req: Request): string {
  return req.user?.sub ?? "anonymous";
}

function canAccessGroup(req: Request, group: { userId: string }): boolean {
  if (!req.user) return true; // auth disabled
  return group.userId === getUserId(req);
}

/**
 * 清洗 group 排序数组：
 *  - 剔除 validIds 中不存在的 id
 *  - 把 validIds 中存在但 order 中没有的 id 追加到末尾（防止脏数据 / 新建分组未及时同步）
 */
function sanitizeOrder(
  order: readonly string[] | undefined,
  validIds: readonly string[],
): string[] {
  const validSet = new Set(validIds);
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const id of order ?? []) {
    if (validSet.has(id) && !seen.has(id)) {
      cleaned.push(id);
      seen.add(id);
    }
  }
  for (const id of validIds) {
    if (!seen.has(id)) cleaned.push(id);
  }
  return cleaned;
}

export interface GroupsRouterOptions {
  groupStore: GroupStore;
  agentCwd: string;
  userStore?: UserStore;
  agentStore?: AgentStore;
  broadcastToUser?: (userId: string, data: object) => void;
  /** 中央事件总线（优先于 broadcastToUser），延迟求值避免初始化时序问题 */
  getEventBus?: () => EventBus | undefined;
  loginLogFilePath?: string;
}

export function createGroupsRouter(options: GroupsRouterOptions): Router {
  const { groupStore, agentCwd, userStore, agentStore } = options;
  const router = Router();

  function getSessionAgent(username?: string): SessionAgent | undefined {
    if (!username) return undefined;
    const profile = agentStore?.getOrDefault(username);
    if (!profile) return undefined;
    return {
      username: profile.username,
      name: profile.name,
      ...(profile.signature !== undefined ? { signature: profile.signature } : {}),
      ...(profile.avatar !== undefined ? { avatar: profile.avatar } : {}),
      ...(profile.avatarVersion !== undefined ? { avatarVersion: profile.avatarVersion } : {}),
    };
  }

  /**
   * Validate that all sessionIds belong to the expected user.
   * Returns an error string if validation fails, null if OK.
   */
  async function validateSessionOwnership(
    sessionIds: string[],
    expectedUserId: string,
  ): Promise<string | null> {
    if (!userStore) return null; // auth disabled → skip
    const user = userStore.findById(expectedUserId);
    if (!user) return `Owner user ${expectedUserId} not found`;

    const userCwd = resolveUserCwd(agentCwd, user);
    for (const sid of sessionIds) {
      const primaryPath = getTranscriptPath(userCwd, sid, {
        tenantId: user.tenantId,
        userId: user.id,
      });
      let meta = await readSessionMeta(primaryPath);

      // Keep group mutations aligned with the session list/detail endpoints: a
      // visible session may still be meta-only or live in an older/migrated
      // transcript location, so fall back to the global resolver before
      // rejecting the operation.
      if (!meta) {
        const fallbackPath = await findTranscriptOrMetaPathBySessionId(sid);
        if (fallbackPath && fallbackPath !== primaryPath) {
          meta = await readSessionMeta(fallbackPath);
        }
      }

      if (!meta || meta.userId !== expectedUserId) {
        return `Session ${sid} does not belong to group owner`;
      }
    }
    return null;
  }

  /**
   * GET /api/groups
   * 返回当前用户自己的分组。
   */
  router.get("/groups", (_req: Request, res: Response) => {
    try {
      const groups = groupStore
        .listByUserId(getUserId(_req))
        // 记忆轮询是平台内部维护任务，不属于任何用户的会话目录。
        // 名称后缀兼容旧任务；客户端同样过滤缓存，避免冷启动闪现。
        .filter(
          (group) =>
            group.kind !== "cron" || !isMemoryPollJob({ name: group.name }),
        );
      return res.json({ groups });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * POST /api/groups
   * 所有用户（包括 admin）只能为自己创建分组。
   */
  router.post("/groups", async (req: Request, res: Response) => {
    try {
      const { name, sessionIds, forUser } = req.body as {
        name?: string;
        sessionIds?: string[];
        forUser?: string;
      };
      if (!name?.trim()) {
        res.status(400).json({ error: "name is required" });
        return;
      }

      if (forUser) {
        res.status(403).json({ error: "禁止代其他用户创建分组" });
        return;
      }
      const userId = getUserId(req);

      // Validate session ownership if initial sessionIds provided
      if (sessionIds?.length) {
        const err = await validateSessionOwnership(sessionIds, userId);
        if (err) {
          res.status(400).json({ error: err });
          return;
        }
      }

      const group = await groupStore.create({
        name: name.trim(),
        kind: "manual",
        sessionIds: sessionIds ?? [],
        userId,
      });

      // If sessionIds provided, enforce single-group membership
      if (sessionIds?.length) {
        await groupStore.addSessions(group.id, sessionIds, userId);
      }

      // Re-fetch to return the final state after addSessions dedup
      const final = groupStore.findById(group.id) ?? group;
      if (options.loginLogFilePath) {
        auditLog(req, "group_created", `${final.name} (${final.id})`);
      }
      res.status(201).json(final);

      const eventBus = options.getEventBus?.();
      if (eventBus) {
        eventBus.emitUser(userId, { type: "groups_changed" });
      } else {
        options.broadcastToUser?.(userId, { type: "groups_changed" });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * PATCH /api/groups/:id
   */
  router.patch("/groups/:id", async (req: Request, res: Response) => {
    try {
      const group = groupStore.findById(req.params.id);
      if (!group) {
        res.status(404).json({ error: "Group not found" });
        return;
      }
      if (!canAccessGroup(req, group)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      const { name, sessionIds } = req.body as {
        name?: string;
        sessionIds?: string[];
      };

      // 非 admin 用户更新 sessionIds 时校验归属
      if (sessionIds !== undefined) {
        const ownershipErr = await validateSessionOwnership(
          sessionIds,
          group.userId,
        );
        if (ownershipErr) {
          res.status(400).json({ error: ownershipErr });
          return;
        }
      }

      const updated = await groupStore.update(req.params.id, {
        ...(name !== undefined ? { name } : {}),
        ...(sessionIds !== undefined ? { sessionIds } : {}),
      });
      if (!updated) {
        res.status(404).json({ error: "Group not found" });
        return;
      }
      if (options.loginLogFilePath) {
        auditLog(req, "group_updated", `${group.name} (${group.id})`);
      }
      res.json(updated);

      const eventBus = options.getEventBus?.();
      if (eventBus) {
        eventBus.emitUser(group.userId, { type: "groups_changed" });
      } else {
        options.broadcastToUser?.(group.userId, { type: "groups_changed" });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * DELETE /api/groups/:id
   */
  router.delete("/groups/:id", async (req: Request, res: Response) => {
    try {
      const group = groupStore.findById(req.params.id);
      if (!group) {
        res.status(404).json({ error: "Group not found" });
        return;
      }
      if (!canAccessGroup(req, group)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      const deletedGroupUserId = group.userId;
      await groupStore.delete(req.params.id);
      if (options.loginLogFilePath) {
        auditLog(req, "group_deleted", `${group.name} (${group.id})`);
      }
      res.json({ ok: true });

      const eventBus = options.getEventBus?.();
      if (eventBus) {
        eventBus.emitUser(deletedGroupUserId, { type: "groups_changed" });
      } else {
        options.broadcastToUser?.(deletedGroupUserId, {
          type: "groups_changed",
        });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * POST /api/groups/:id/sessions
   * Body: { sessionIds: string[] }
   * Validates session ownership: sessions must belong to the group's owner.
   */
  router.post("/groups/:id/sessions", async (req: Request, res: Response) => {
    try {
      const group = groupStore.findById(req.params.id);
      if (!group) {
        res.status(404).json({ error: "Group not found" });
        return;
      }
      if (!canAccessGroup(req, group)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      const { sessionIds } = req.body as { sessionIds?: string[] };
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        res.status(400).json({ error: "sessionIds must be a non-empty array" });
        return;
      }

      // Validate session ownership
      const ownershipErr = await validateSessionOwnership(
        sessionIds,
        group.userId,
      );
      if (ownershipErr) {
        res.status(400).json({ error: ownershipErr });
        return;
      }

      const updated = await groupStore.addSessions(
        req.params.id,
        sessionIds,
        group.userId,
      );
      if (!updated) {
        res.status(404).json({ error: "Group not found" });
        return;
      }
      if (options.loginLogFilePath) {
        auditLog(
          req,
          "group_sessions_added",
          `${group.name} (${group.id}) +${sessionIds.length}`,
        );
      }
      res.json({ group: updated });

      const eventBus = options.getEventBus?.();
      if (eventBus) {
        eventBus.emitUser(group.userId, { type: "groups_changed" });
      } else {
        options.broadcastToUser?.(group.userId, { type: "groups_changed" });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * DELETE /api/groups/:id/sessions
   * Body: { sessionIds: string[] }
   */
  router.delete("/groups/:id/sessions", async (req: Request, res: Response) => {
    try {
      const group = groupStore.findById(req.params.id);
      if (!group) {
        res.status(404).json({ error: "Group not found" });
        return;
      }
      if (!canAccessGroup(req, group)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      const { sessionIds } = req.body as { sessionIds?: string[] };
      if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
        res.status(400).json({ error: "sessionIds must be a non-empty array" });
        return;
      }

      const updated = await groupStore.removeSessions(
        req.params.id,
        sessionIds,
      );
      if (!updated) {
        res.status(404).json({ error: "Group not found" });
        return;
      }
      if (options.loginLogFilePath) {
        auditLog(
          req,
          "group_sessions_removed",
          `${group.name} (${group.id}) -${sessionIds.length}`,
        );
      }
      res.json({ group: updated });

      const eventBus = options.getEventBus?.();
      if (eventBus) {
        eventBus.emitUser(group.userId, { type: "groups_changed" });
      } else {
        options.broadcastToUser?.(group.userId, { type: "groups_changed" });
      }
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * GET /api/groups/:id/sessions
   * Returns enriched session list for a specific group (all members, no pagination).
   */
  router.get("/groups/:id/sessions", async (req: Request, res: Response) => {
    try {
      const group = groupStore.findById(req.params.id);
      if (!group) {
        res.status(404).json({ error: "Group not found" });
        return;
      }
      if (!canAccessGroup(req, group)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }

      if (group.sessionIds.length === 0) {
        res.json({ sessions: [] });
        return;
      }

      // Resolve owner CWD for transcript path lookup
      const ownerUser = userStore?.findById(group.userId);
      const ownerCwd = ownerUser
        ? resolveUserCwd(agentCwd, {
            id: ownerUser.id,
            username: ownerUser.username,
            role: ownerUser.role,
            tenantId: ownerUser.tenantId,
          })
        : agentCwd;

      const sessions = await Promise.all(
        group.sessionIds.map(async (sessionId) => {
          // Try per-user dir first, fallback to global dir
          const primaryPath = getTranscriptPath(ownerCwd, sessionId, ownerUser ? { tenantId: ownerUser.tenantId, userId: ownerUser.id } : undefined);
          let transcriptPath = primaryPath;
          if (ownerCwd !== agentCwd) {
            try {
              await fs.access(primaryPath);
            } catch {
              transcriptPath = getTranscriptPath(agentCwd, sessionId);
            }
          }

          try {
            const stat = await fs.stat(transcriptPath);
            const [meta, summary] = await Promise.all([
              readSessionMeta(transcriptPath),
              summarizeTranscript(transcriptPath),
            ]);
            if (meta?.deletedAt) return null;
            if (hidesMemoryPollFrom(req.user, meta)) {
              return null;
            }

            // 标题优先级：customTitle > cron jobName > generatedTitle > transcript 自动提取
            const autoTitle =
              group.kind === "cron" && group.name
                ? group.name
                : meta?.generatedTitle || summary.title;
            const title = meta?.customTitle || autoTitle;
            const preview = summary.preview
              ? summary.preview
                  .replace(/^#{1,6}\s+/gm, "")
                  .replace(/\*\*(.+?)\*\*/g, "$1")
                  .replace(/`(.+?)`/g, "$1")
                  .replace(/\n{2,}/g, " ")
                  .trim()
                  .slice(0, 200)
              : undefined;

            const source =
              group.kind === "cron"
                ? { type: "cron" as const, label: "cron" }
                : { type: "web" as const, label: "WEB" };
            const owner = meta
              ? { userId: meta.userId, username: meta.username }
              : undefined;
            const agent = getSessionAgent(owner?.username);

            return {
              sessionId,
              updatedAtMs: stat.mtimeMs,
              createdAtMs: summary.createdAtMs ?? stat.mtimeMs,
              title,
              preview,
              source,
              ...(owner ? { owner } : {}),
              ...(agent ? { agent } : {}),
              ...(meta?.model ? { model: meta.model } : {}),
              ...(group.cronJobId
                ? { cronJobId: group.cronJobId, cronJobName: group.name }
                : {}),
            };
          } catch {
            return null; // session file missing or unreadable
          }
        }),
      );

      const validSessions = sessions.filter(
        (s): s is NonNullable<typeof s> => s !== null,
      );
      validSessions.sort((a, b) => b.updatedAtMs - a.updatedAtMs);

      res.json({ sessions: validSessions });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
