/**
 * 场景库路由
 *
 * GET /api/scenarios —— 返回按岗位分组的预置场景卡片库 { roles, scenarios }。
 * 所有登录用户可读（走全局 /api 鉴权中间件，无 admin 限制）。
 *
 * 数据源为随代码发布的静态 JSON（src/data/scenarios/scenario-library-v1.json）。
 * 下发前必须：
 *  1. 过滤掉 enabled !== true 的条目（未上架场景不出库）；
 *  2. 剥离 source / enabled / salesPitch 字段；
 *  3. 对所有客户面字符串跑 sanitize。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type {
  ScenarioItem,
  ScenarioItemInternal,
  ScenarioLibraryFile,
  ScenarioLibraryResponse,
} from "../../../shared/src/types/scenario.js";
import { buildScenarioPrompt } from "../../../shared/src/types/scenario.js";
import {
  cronWizardSubmitSchema,
  scenarioLibraryFileSchema,
} from "../../../shared/src/index.js";
import {
  sanitizeRole,
  sanitizeScenario,
} from "../../../shared/src/security/sanitizeCustomerFacingText.js";
import type { CronService } from "../cron/service.js";
import type { CronJobCreate, NotifyConfig } from "../cron/types.js";

const DEFAULT_DATA_PATH = resolve(
  import.meta.dirname,
  "../data/scenarios/scenario-library-v1.json",
);

export interface RoleKitPublicConfig {
  v2Enabled?: boolean;
  sanitizePreviewEnabled?: boolean;
  firstDayGuideBar?: {
    enabled?: boolean;
    stageTimeoutMs?: number;
    showOnMobile?: boolean;
  };
  roleSwitcher?: {
    enabled?: boolean;
    position?: "top-left" | "top-right";
  };
  libraryVersion?: "v1" | "v2";
}

export interface ScenariosRouterOptions {
  /** 场景库 JSON 路径（测试注入用；缺省为随代码发布的 v1 数据文件） */
  dataPath?: string;
  cronService?: CronService;
  roleKit?: RoleKitPublicConfig;
}

async function loadScenarioLibraryFile(dataPath: string): Promise<ScenarioLibraryFile> {
  const raw = JSON.parse(await readFile(dataPath, "utf-8")) as unknown;
  const parsed = scenarioLibraryFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `scenario-library validation failed:\n${parsed.error.issues
        .map((issue) => `  · ${issue.path.join(".")}: ${issue.message}`)
        .join("\n")}`,
    );
  }
  return parsed.data as ScenarioLibraryFile;
}

function toPublicLibrary(raw: ScenarioLibraryFile): ScenarioLibraryResponse {
  const roles = [...raw.roles]
    .sort((a, b) => a.sort - b.sort)
    .map((role) => sanitizeRole({ ...role }).scenario as ScenarioLibraryResponse["roles"][number]);
  const scenarios: ScenarioItem[] = raw.scenarios
    .filter((item) => item.enabled === true)
    .map((item) => {
      const { source: _source, enabled: _enabled, salesPitch: _salesPitch, ...publicFields } = item;
      return sanitizeScenario(publicFields).scenario as ScenarioItem;
    });
  return { roles, scenarios };
}

function buildScenarioPromptWithTargets(
  scenario: Pick<ScenarioItem, "promptTemplate" | "slots">,
  monitorTargets: string[],
): string {
  if (scenario.slots.length === 0) return buildScenarioPrompt(scenario);
  const first = scenario.slots[0];
  const next = {
    ...scenario,
    slots: [
      { ...first, example: monitorTargets.join("、") },
      ...scenario.slots.slice(1),
    ],
  };
  return buildScenarioPrompt(next);
}

function mapPushSlotToNotify(
  pushSlot: z.infer<typeof cronWizardSubmitSchema>["pushSlot"],
  currentUserId: string,
): NotifyConfig {
  if (pushSlot.target === "group") {
    return {
      enabled: true,
      channel: "dingtalk",
      onSuccess: true,
      onError: true,
      dingtalk: { mode: "chat", chatId: `scenario-role-kit-${currentUserId}` },
    };
  }
  return {
    enabled: true,
    channel: "dingtalk",
    onSuccess: true,
    onError: true,
    dingtalk: { mode: "user", userId: currentUserId },
  };
}

function buildCronCreate(
  scenario: ScenarioItemInternal,
  body: z.infer<typeof cronWizardSubmitSchema>,
  currentUserId: string,
): CronJobCreate {
  const firstTarget = body.monitorTargets[0] ?? scenario.title;
  return {
    name: `${scenario.title}（${firstTarget}${body.monitorTargets.length > 1 ? "等" : ""}）`,
    description: "由岗位开箱包常驻监测向导创建",
    enabled: true,
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "Asia/Shanghai" },
    payload: {
      kind: "agentTurn",
      message: buildScenarioPromptWithTargets(scenario, body.monitorTargets),
      context: { systemPrompt: true, persona: true, memory: true },
    },
    notify: mapPushSlotToNotify(body.pushSlot, currentUserId),
  };
}

export function createScenariosRouter(
  options: ScenariosRouterOptions = {},
): Router {
  const dataPath = options.dataPath ?? DEFAULT_DATA_PATH;
  const router = Router();

  // 进程内缓存：场景库是随代码发布的静态数据，进程生命周期内加载一次即可
  let cache: ScenarioLibraryResponse | null = null;
  let rawCache: ScenarioLibraryFile | null = null;

  async function getRawLibrary(): Promise<ScenarioLibraryFile> {
    if (!rawCache) rawCache = await loadScenarioLibraryFile(dataPath);
    return rawCache;
  }

  async function getPublicLibrary(): Promise<ScenarioLibraryResponse> {
    if (!cache) cache = toPublicLibrary(await getRawLibrary());
    return cache;
  }

  router.get("/config", (_req: Request, res: Response) => {
    const roleKit = options.roleKit ?? {};
    res.json({
      roleKitV2Enabled: roleKit.v2Enabled === true,
      sanitizePreviewEnabled: roleKit.sanitizePreviewEnabled === true,
      firstDayGuideBar: {
        enabled: roleKit.firstDayGuideBar?.enabled === true,
        stageTimeoutMs: roleKit.firstDayGuideBar?.stageTimeoutMs ?? 5_400_000,
        showOnMobile: roleKit.firstDayGuideBar?.showOnMobile === true,
      },
      roleSwitcher: {
        enabled: roleKit.roleSwitcher?.enabled === true,
        position: roleKit.roleSwitcher?.position ?? "top-right",
      },
      libraryVersion: roleKit.libraryVersion ?? "v1",
    });
  });

  router.get("/", async (_req: Request, res: Response) => {
    try {
      res.json(await getPublicLibrary());
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  router.post("/create-cron", async (req: Request, res: Response) => {
    if (!options.cronService) {
      res.status(503).json({ error: "cron_unavailable" });
      return;
    }
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const parsed = cronWizardSubmitSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    try {
      const body = parsed.data;
      const raw = await getRawLibrary();
      const scenario = raw.scenarios.find((item) => item.id === body.scenarioId && item.enabled === true);
      if (!scenario || scenario.mode !== "recurring") {
        res.status(400).json({ error: "scenario_not_recurring" });
        return;
      }
      if (scenario.pushSlot?.humanReviewRequired === true && body.pushSlot.humanReviewRequired !== true) {
        res.status(400).json({ error: "human_review_required" });
        return;
      }
      const created = await options.cronService.add(
        buildCronCreate(scenario, body, req.user.sub),
        { owner: req.user.sub, ownerName: req.user.username },
      );
      res.status(200).json({
        cronJobId: created.id,
        scenarioId: scenario.id,
        createdAt: new Date(created.createdAtMs).toISOString(),
      });
    } catch (err) {
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  return router;
}
