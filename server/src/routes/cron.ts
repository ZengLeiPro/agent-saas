/**
 * Cron API 路由
 */
import { Router } from "express";
import type { Request, Response } from "express";
import type { CronService } from "../cron/service.js";
import type { CronJob } from "../cron/types.js";
import { cronJobCreateSchema, cronJobPatchSchema } from "../cron/types.js";
import { validateCronExpr } from "../cron/scheduler.js";
import { readRunLog } from "../cron/run-log.js";
import {
  findTranscriptPathBySessionId,
  parseTranscriptFile,
} from "../data/transcripts/index.js";
import type { GroupStore } from "../data/groups/index.js";
import { auditLog } from "../data/login-logs/index.js";
import { isPlatformAdminUser } from "../data/sessions/access.js";

/** 是否可管理/查看：所有登录用户（包括 admin）仅自己的任务；auth 未启用时放行。 */
function canAccess(req: Request, job: CronJob): boolean {
  if (!req.user) return true;
  return job.owner === req.user.sub;
}

/**
 * 平台系统任务（memory_poll 等，2026-07-14 批次）：
 * 只有平台管理员（pantheon 租户 admin）能在列表/详情中看到——
 * 组织管理员与普通用户一律隐藏，与记忆轮询会话可见性保持同一规则
 * （B 方案，data/sessions/access.ts hidesMemoryPollFrom 同源判断）。
 * 任何人都不得经 API 修改/删除——由平台 reconcile 统一管理，租户级
 * 开关走 TenantSettings.features.memoryPollingEnabled。
 */
function isSystemJob(job: CronJob): boolean {
  return !!job.systemKind;
}

function canSeeSystemJob(req: Request): boolean {
  if (!req.user) return true;
  return isPlatformAdminUser(req.user
    ? { role: req.user.role, tenantId: req.user.tenantId }
    : undefined);
}

/** 钉钉通知交叉字段校验（Zod 结构校验后的语义校验） */
function validateDingtalkNotify(notify: {
  enabled: boolean;
  channel: string;
  dingtalk?: {
    mode?: string;
    conversationId?: string;
    userId?: string | string[];
    chatId?: string;
  };
}): string | null {
  if (!notify.enabled) return null;
  const needsDingtalk =
    notify.channel === "dingtalk" || notify.channel === "both";
  if (!needsDingtalk) return null;

  const mode = notify.dingtalk?.mode ?? "session";
  if (mode === "session") {
    if (!notify.dingtalk?.conversationId?.trim()) {
      return "notify.dingtalk.conversationId is required when notify.channel includes dingtalk and notify.dingtalk.mode=session";
    }
  } else if (mode === "user") {
    const userId = notify.dingtalk?.userId;
    const ok =
      (typeof userId === "string" && userId.trim()) ||
      (Array.isArray(userId) && userId.some((s) => String(s).trim()));
    if (!ok) {
      return "notify.dingtalk.userId is required when notify.channel includes dingtalk and notify.dingtalk.mode=user";
    }
  } else if (mode === "chat") {
    if (!notify.dingtalk?.chatId?.trim()) {
      return "notify.dingtalk.chatId is required when notify.channel includes dingtalk and notify.dingtalk.mode=chat";
    }
  }
  return null;
}

export function createCronRouter(
  cronService: CronService,
  runsDir: string,
  groupStore?: GroupStore,
): Router {
  const router = Router();

  const normalizeEntry = (raw: any, index: number) => {
    if (
      raw?.runId &&
      typeof raw.startedAtMs === "number" &&
      typeof raw.endedAtMs === "number"
    ) {
      return raw;
    }

    // Legacy format: { ts, output? } etc.
    const ts = typeof raw?.ts === "number" ? raw.ts : Date.now();
    const durationMs = typeof raw?.durationMs === "number" ? raw.durationMs : 0;
    return {
      runId: raw?.runId ?? `legacy-${ts}-${index}`,
      startedAtMs: raw?.startedAtMs ?? ts,
      endedAtMs: raw?.endedAtMs ?? ts + durationMs,
      jobId: raw?.jobId,
      jobName: raw?.jobName,
      status: raw?.status,
      error: raw?.error,
      sessionId: raw?.sessionId,
      transcriptPath: raw?.transcriptPath,
      durationMs,
    };
  };

  router.get("/status", async (_req: Request, res: Response) => {
    try {
      res.json(cronService.getStatus());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/jobs", async (req: Request, res: Response) => {
    try {
      const includeDisabled = req.query.includeDisabled === "true";
      const allJobs = await cronService.list({ includeDisabled });
      const jobs = allJobs.filter((job) => canAccess(req, job) && (!isSystemJob(job) || canSeeSystemJob(req)));
      res.json({ jobs });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/jobs/:id", async (req: Request, res: Response) => {
    try {
      const job = await cronService.get(req.params.id);
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      if (!canAccess(req, job)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
      if (isSystemJob(job) && !canSeeSystemJob(req)) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      res.json(job);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/jobs", async (req: Request, res: Response) => {
    try {
      const parsed = cronJobCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const create = parsed.data;

      if (create.schedule.kind === "cron") {
        const validation = validateCronExpr(
          create.schedule.expr,
          create.schedule.tz,
        );
        if (!validation.valid) {
          res
            .status(400)
            .json({ error: `Invalid cron expression: ${validation.error}` });
          return;
        }
      }

      if (create.notify) {
        const notifyErr = validateDingtalkNotify(create.notify);
        if (notifyErr) {
          res.status(400).json({ error: notifyErr });
          return;
        }
      }

      const context = req.user
        ? { owner: req.user.sub, ownerName: req.user.username }
        : undefined;
      const job = await cronService.add(create, context);
      auditLog(req, "cron_job_created", job.name);
      res.status(201).json(job);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.patch("/jobs/:id", async (req: Request, res: Response) => {
    try {
      const existing = await cronService.get(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      if (!canAccess(req, existing)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
      if (isSystemJob(existing)) {
        res.status(403).json({ error: "系统任务由平台管理，不能通过 API 修改" });
        return;
      }

      const parsed = cronJobPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.issues[0].message });
        return;
      }
      const patch = parsed.data;

      if (patch.schedule?.kind === "cron") {
        const validation = validateCronExpr(
          patch.schedule.expr,
          patch.schedule.tz,
        );
        if (!validation.valid) {
          res
            .status(400)
            .json({ error: `Invalid cron expression: ${validation.error}` });
          return;
        }
      }

      if (patch.notify) {
        const notifyErr = validateDingtalkNotify(patch.notify);
        if (notifyErr) {
          res.status(400).json({ error: notifyErr });
          return;
        }
      }

      let job: CronJob | undefined;
      try {
        job = await cronService.update(req.params.id, patch);
      } catch (err) {
        res
          .status(400)
          .json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      if (!job) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      // 同步 cron group 名称
      if (patch.name && groupStore) {
        const group = groupStore.findByCronJobId(req.params.id);
        if (group && group.name !== job.name) {
          await groupStore.update(group.id, { name: job.name });
        }
      }
      // 审计：区分启停和常规编辑
      if (patch.enabled !== undefined && Object.keys(patch).length === 1) {
        auditLog(
          req,
          "cron_job_toggled",
          `${job.name} → ${patch.enabled ? "启用" : "禁用"}`,
        );
      } else {
        auditLog(req, "cron_job_updated", job.name);
      }
      res.json(job);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/jobs/:id", async (req: Request, res: Response) => {
    try {
      const existing = await cronService.get(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      if (!canAccess(req, existing)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
      if (isSystemJob(existing)) {
        res.status(403).json({ error: "系统任务由平台管理，不能通过 API 删除" });
        return;
      }
      await cronService.remove(req.params.id);
      auditLog(req, "cron_job_deleted", existing.name);

      // Detach associated cron group -> downgrade to manual
      if (groupStore) {
        const group = groupStore.findByCronJobId(req.params.id);
        if (group) {
          await groupStore.updateInternal(group.id, {
            kind: "manual",
            cronJobId: undefined,
          });
        }
      }

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/jobs/:id/run", async (req: Request, res: Response) => {
    try {
      const existing = await cronService.get(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      if (!canAccess(req, existing)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
      const result = await cronService.runNow(req.params.id);
      if (!result.ran) {
        res.status(400).json({ error: result.error });
        return;
      }
      auditLog(req, "cron_job_triggered", existing.name);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/jobs/:id/runs", async (req: Request, res: Response) => {
    try {
      const existing = await cronService.get(req.params.id);
      if (!existing) {
        res.status(404).json({ error: "Job not found" });
        return;
      }
      if (!canAccess(req, existing)) {
        res.status(403).json({ error: "Access denied" });
        return;
      }
      const limit = parseInt(req.query.limit as string) || 50;
      const rawEntries = await readRunLog(req.params.id, { runsDir, limit });
      const entries = rawEntries.map((e: any, i: number) => {
        const normalized = normalizeEntry(e, i);
        return {
          ...normalized,
          hasTranscript: !!normalized.transcriptPath || !!normalized.sessionId,
          transcriptPath: undefined,
        };
      });
      res.json({ entries });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get(
    "/jobs/:id/runs/:runId/details",
    async (req: Request, res: Response) => {
      try {
        const jobId = req.params.id;
        const runId = req.params.runId;

        const existing = await cronService.get(jobId);
        if (!existing) {
          res.status(404).json({ error: "Job not found" });
          return;
        }
        if (!canAccess(req, existing)) {
          res.status(403).json({ error: "Access denied" });
          return;
        }

        const entries = await readRunLog(jobId, { runsDir, limit: 5000 });
        const entry = (entries as any[])
          .map((e, i) => normalizeEntry(e, i))
          .find((e) => e?.runId === runId);
        if (!entry) {
          res.status(404).json({ error: "Run not found" });
          return;
        }

        if (!entry.transcriptPath) {
          if (entry.sessionId) {
            const found = await findTranscriptPathBySessionId(entry.sessionId);
            if (found) {
              entry.transcriptPath = found;
            }
          }
        }

        if (!entry.transcriptPath) {
          res.status(409).json({
            error:
              "Run has no transcriptPath, and transcript could not be located by sessionId. (Was persistSession enabled at run time?)",
          });
          return;
        }

        const parsed = await parseTranscriptFile(entry.transcriptPath);

        res.json({
          run: {
            ...entry,
            hasTranscript: true,
            transcriptPath: undefined,
          },
          transcript: {
            sessionId: parsed.sessionId ?? entry.sessionId,
            stats: parsed.stats,
          },
          blocks: parsed.blocks,
        });
      } catch (err) {
        const msg = String(err instanceof Error ? err.message : err);
        if (msg.includes("outside allowed directory")) {
          res.status(403).json({ error: msg });
          return;
        }
        res.status(500).json({ error: msg });
      }
    },
  );

  router.post("/validate", (req: Request, res: Response) => {
    const { expr, tz } = req.body ?? {};
    if (!expr) {
      res.status(400).json({ error: "Expression is required" });
      return;
    }
    res.json(validateCronExpr(String(expr), tz ? String(tz) : undefined));
  });

  return router;
}
