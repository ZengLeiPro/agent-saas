/**
 * Groups API 路由
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { FileHandle } from "node:fs/promises";
import { SmartGroupingConflictError, type GroupStore } from "../data/groups/index.js";
import type { UserStore } from "../data/users/store.js";
import type { GroupSortingPref } from "../data/users/types.js";
import { resolveUserCwd } from "../workspace/resolver.js";
import {
  findTranscriptOrMetaPathBySessionId,
  getTranscriptPath,
  listSessions,
} from "../data/transcripts/store.js";
import { readSessionMeta } from "../data/transcripts/meta.js";
import type { TranscriptSummary } from "../data/transcripts/parse.js";
import { openTrustedTranscript } from "../data/transcripts/trusted.js";
import { auditLog } from "../data/login-logs/index.js";
import type { EventBus } from "../channels/web/eventBus.js";
import type { AgentStore } from "../data/agents/store.js";
import type { AgentProfileInfo } from "../data/agents/types.js";
import { hidesMemoryPollFrom } from "../data/sessions/access.js";
import { isMemoryPollJob } from "../cron/memoryPoll.js";
import { DEFAULT_TENANT_ID } from "../data/tenants/types.js";
import { extractTitleContext, type TitleGeneratorConfig, type TitleModelAdapterFactory } from "../agent/titleGenerator.js";
import { SESSION_GROUPING_SYSTEM_PROMPT, generateSessionGroupingSuggestion, type SessionGroupingCandidate } from "../agent/sessionGroupGenerator.js";
import { appendUserPromptAddition } from "../agent/userPromptComposition.js";
import type { TokenUsageStore } from "../data/usage/store.js";
import type { BillingService } from "../data/billing/service.js";

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

function transcriptText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find((item: any) => item?.type === "text");
  return typeof block?.text === "string" ? block.text : undefined;
}

function transcriptTitle(content: string): string {
  let text = content.replace(/^<memory-context>[\s\S]*?<\/memory-context>\s*/, "");
  const marker = "[用户消息]";
  const markerIndex = text.indexOf(marker);
  if (markerIndex >= 0) text = text.slice(markerIndex + marker.length).trim();
  return text
    .replace(/^\[\d{4}\/\d{2}\/\d{2}\s+(?:周[一二三四五六日]\s+)?\d{2}:\d{2}\]\s*/, "")
    .slice(0, 100);
}

/** Builds the group-list summary from the already opened transcript inode. */
async function summarizeOpenedTranscript(handle: FileHandle, size: number): Promise<TranscriptSummary> {
  const LARGE_THRESHOLD = 128 * 1024;
  let lines: string[];
  if (size <= LARGE_THRESHOLD) {
    lines = (await handle.readFile({ encoding: "utf-8" })).split("\n");
  } else {
    const headSize = Math.min(8192, size);
    const tailSize = Math.min(64 * 1024, size);
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(tailSize);
    await Promise.all([
      handle.read(head, 0, headSize, 0),
      handle.read(tail, 0, tailSize, size - tailSize),
    ]);
    const headLines = head.toString("utf-8").split("\n");
    if (headSize < size) headLines.pop();
    const tailLines = tail.toString("utf-8").split("\n");
    if (tailSize < size) tailLines.shift();
    lines = [...headLines, ...tailLines];
  }

  let title: string | undefined;
  let preview: string | undefined;
  let createdAtMs: number | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (createdAtMs === undefined) {
      const value = record?.timestamp ?? record?.ts ?? record?.startedAtMs;
      const parsed = typeof value === "number" ? value : Date.parse(value);
      if (Number.isFinite(parsed)) createdAtMs = parsed;
    }
    if (title === undefined && record?.type === "user") {
      const text = transcriptText(record?.message?.content);
      if (text && !text.trimStart().startsWith("<skill-context")) title = transcriptTitle(text);
    }
    if (record?.type === "assistant") {
      const text = transcriptText(record?.message?.content);
      if (text) preview = text.slice(0, 200);
    }
  }
  return { ...(title ? { title } : {}), ...(preview ? { preview } : {}), ...(createdAtMs !== undefined ? { createdAtMs } : {}) };
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
  titleGeneratorConfigs?: TitleGeneratorConfig[];
  titleModelAdapterFactory?: TitleModelAdapterFactory;
  refreshSharedConfig?: (force?: boolean) => void | boolean | Promise<boolean>;
  getSessionGroupingSystemPrompt?: () => string;
  tokenUsageStore?: TokenUsageStore;
  billingService?: BillingService;
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

  /** 生成只读智能分组方案；不会修改现有分组。 */
  router.post("/groups/smart-plan", async (req: Request, res: Response) => {
    if (!req.user || !userStore) { res.status(401).json({ error: "Authentication required" }); return; }
    const scope = req.body?.scope === "all" ? "all" : req.body?.scope === "ungrouped" ? "ungrouped" : null;
    if (!scope) { res.status(400).json({ error: "scope must be ungrouped or all" }); return; }
    if (await options.refreshSharedConfig?.(true) === false) { res.status(503).json({ error: "Shared config refresh failed" }); return; }
    if (!options.titleGeneratorConfigs?.length) { res.status(501).json({ error: "Smart grouping model not configured" }); return; }
    try {
      const userId = req.user.sub;
      const workspaceUser = { id: userId, username: req.user.username, role: req.user.role, tenantId: req.user.tenantId };
      const userCwd = resolveUserCwd(agentCwd, workspaceUser);
      const owner = { tenantId: req.user.tenantId, userId };
      const allGroups = groupStore.listByUserId(userId);
      const fingerprint = groupStore.getUserSnapshotFingerprint(userId);
      const protectedIds = new Set(allGroups.filter(group => group.kind !== "manual").flatMap(group => group.sessionIds));
      const groupedIds = new Set(allGroups.flatMap(group => group.sessionIds));
      const page = await listSessions(userCwd, { limit: Number.MAX_SAFE_INTEGER, owner });
      const candidates: SessionGroupingCandidate[] = [];
      for (const session of page.items) {
        if (protectedIds.has(session.sessionId) || (scope === "ungrouped" && groupedIds.has(session.sessionId))) continue;
        const transcriptPath = getTranscriptPath(userCwd, session.sessionId, owner);
        const meta = await readSessionMeta(transcriptPath);
        if (!meta || meta.userId !== userId || meta.deletedAt || meta.channel === "cron"
          || meta.sessionSource === "taskboard_execution" || meta.sessionSource === "memory_consolidation") continue;
        const context = await extractTitleContext(transcriptPath).catch(() => null);
        if (!context?.userMessages.length) continue;
        candidates.push({
          sessionId: session.sessionId,
          title: (meta.customTitle || meta.generatedTitle || context.userMessages[0]!).slice(0, 100),
          userMessages: context.userMessages,
          assistantReplies: context.assistantReplies,
        });
        if (candidates.length > 100) break;
      }
      const truncated = candidates.length > 100;
      candidates.splice(100);
      if (candidates.length === 0) {
        res.json({ scope, fingerprint, groups: [], ungroupedSessionIds: [], sessions: [], truncated: false });
        return;
      }
      const utilityBilling = options.billingService
        ? await options.billingService.beginUtilityModelRun({
            tenantId: req.user.tenantId ?? DEFAULT_TENANT_ID,
            userId, username: req.user.username, channel: "session_grouping",
          })
        : undefined;
      let suggestion;
      try {
        suggestion = await generateSessionGroupingSuggestion({
          candidates,
          existingGroupNames: allGroups.filter(group => group.kind === "manual").map(group => group.name),
          configs: options.titleGeneratorConfigs,
          systemPrompt: appendUserPromptAddition(
            options.getSessionGroupingSystemPrompt?.() ?? SESSION_GROUPING_SYSTEM_PROMPT,
            userStore.findById(userId)?.preferences?.sessionGroupingPromptAddition,
            "session-grouping",
          ),
          options: {
            modelAdapterFactory: options.titleModelAdapterFactory,
            runtimeContext: { sessionId: candidates[0]!.sessionId, tenantId: req.user.tenantId, cwd: userCwd },
            beforeModelCall: () => utilityBilling?.beforeModelCall(),
            onUsage: async (model, usage) => {
              await utilityBilling?.recordUsage(model, usage);
              options.tokenUsageStore?.recordResult({
                username: req.user!.username,
                tenantId: req.user!.tenantId ?? DEFAULT_TENANT_ID,
                channel: "session_grouping",
                modelUsage: { [model]: usage },
                occurredAtMs: Date.now(),
              });
            },
          },
        });
      } finally {
        await utilityBilling?.finalize();
      }
      if (!suggestion) { res.status(502).json({ error: "智能分组生成失败，请重试" }); return; }
      res.json({
        scope,
        fingerprint,
        ...suggestion,
        sessions: candidates.map(candidate => ({ sessionId: candidate.sessionId, title: candidate.title })),
        truncated,
      });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : "智能分组生成失败" });
    }
  });

  /** 应用用户确认后的方案；模型调用和数据写入严格分离。 */
  router.post("/groups/smart-apply", async (req: Request, res: Response) => {
    if (!req.user || !userStore) { res.status(401).json({ error: "Authentication required" }); return; }
    const fingerprint = typeof req.body?.fingerprint === "string" ? req.body.fingerprint : "";
    const targetSessionIds = Array.isArray(req.body?.targetSessionIds) ? req.body.targetSessionIds : null;
    const groups = Array.isArray(req.body?.groups) ? req.body.groups : null;
    if (!fingerprint || !targetSessionIds || targetSessionIds.length > 100 || new Set(targetSessionIds).size !== targetSessionIds.length
      || !targetSessionIds.every((id: unknown) => typeof id === "string")
      || !groups || groups.length > 12 || !groups.every((group: any) => typeof group?.name === "string" && group.name.trim().length > 0 && group.name.trim().length <= 30
        && Array.isArray(group.sessionIds) && group.sessionIds.every((id: unknown) => typeof id === "string"))) {
      res.status(400).json({ error: "智能分组方案格式不正确" }); return;
    }
    try {
      const ownershipError = await validateSessionOwnership(targetSessionIds, req.user.sub);
      if (ownershipError) { res.status(400).json({ error: ownershipError }); return; }
      const userCwd = resolveUserCwd(agentCwd, { id: req.user.sub, username: req.user.username, role: req.user.role, tenantId: req.user.tenantId });
      for (const sessionId of targetSessionIds) {
        const transcriptPath = getTranscriptPath(userCwd, sessionId, { tenantId: req.user.tenantId, userId: req.user.sub });
        const meta = await readSessionMeta(transcriptPath);
        if (!meta || meta.deletedAt || meta.channel === "cron" || meta.sessionSource === "taskboard_execution"
          || meta.sessionSource === "memory_consolidation") {
          res.status(400).json({ error: `会话不可参与智能分组：${sessionId}` }); return;
        }
      }
      const changedGroups = await groupStore.applySmartGrouping({
        userId: req.user.sub,
        expectedFingerprint: fingerprint,
        targetSessionIds,
        groups: groups.map((group: any) => ({ name: group.name.trim(), sessionIds: group.sessionIds })),
      });
      if (options.loginLogFilePath) auditLog(req, "group_updated", `智能分组 ${targetSessionIds.length} 个会话`);
      res.json({ ok: true, groups: changedGroups });
      const eventBus = options.getEventBus?.();
      if (eventBus) eventBus.emitUser(req.user.sub, { type: "groups_changed" });
      else options.broadcastToUser?.(req.user.sub, { type: "groups_changed" });
    } catch (error) {
      if (error instanceof SmartGroupingConflictError) { res.status(409).json({ error: error.message }); return; }
      res.status(500).json({ error: error instanceof Error ? error.message : "智能分组应用失败" });
    }
  });

  /**
   * GET /api/groups-sorting
   * 返回当前用户的跨设备分组排序偏好，并按现有可见分组清洗历史顺序。
   */
  router.get("/groups-sorting", (req: Request, res: Response) => {
    try {
      const userId = getUserId(req);
      const validIds = groupStore
        .listByUserId(userId)
        .filter(
          (group) =>
            group.kind !== "cron" || !isMemoryPollJob({ name: group.name }),
        )
        .map((group) => group.id);
      const stored = userStore?.findById(userId)?.groupSorting;
      res.json({
        mode: stored?.mode ?? "recent",
        order: sanitizeOrder(stored?.order, validIds),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  /**
   * PUT /api/groups-sorting
   * 保存当前用户的跨设备分组排序偏好；未知、重复分组 id 会被清洗。
   */
  router.put("/groups-sorting", async (req: Request, res: Response) => {
    try {
      const { mode, order } = req.body as {
        mode?: unknown;
        order?: unknown;
      };
      if (
        (mode !== "recent" && mode !== "custom") ||
        !Array.isArray(order) ||
        !order.every((id) => typeof id === "string")
      ) {
        res.status(400).json({ error: "mode 或 order 格式不正确" });
        return;
      }

      const userId = getUserId(req);
      const validIds = groupStore
        .listByUserId(userId)
        .filter(
          (group) =>
            group.kind !== "cron" || !isMemoryPollJob({ name: group.name }),
        )
        .map((group) => group.id);
      const sorting: GroupSortingPref = {
        mode,
        order: sanitizeOrder(order, validIds),
      };
      if (userStore) {
        await userStore.updateGroupSorting(userId, sorting);
      }
      res.json(sorting);
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
          let transcript;
          try {
            transcript = await openTrustedTranscript(primaryPath);
          } catch (error) {
            if (ownerCwd === agentCwd || (error as NodeJS.ErrnoException).code !== "ENOENT") return null;
            transcriptPath = getTranscriptPath(agentCwd, sessionId);
            try {
              transcript = await openTrustedTranscript(transcriptPath);
            } catch {
              return null;
            }
          }

          try {
            const stat = transcript.stats;
            const [meta, summary] = await Promise.all([
              readSessionMeta(transcriptPath),
              summarizeOpenedTranscript(transcript.handle, stat.size),
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
          } finally {
            await transcript.handle.close().catch(() => undefined);
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
