/**
 * 场景库路由
 *
 * GET /api/scenarios —— 返回按岗位分组的预置场景卡片库 { roles, scenarios }。
 * 所有登录用户可读（走全局 /api 鉴权中间件，无 admin 限制）。
 *
 * V3 权威源就绪后，旧接口由 legacyCompatibility 投影 53 条兼容形态；
 * 新接口 /v3 只返回 shared 的严格客户投影。测试仍可显式关闭 V3 注入旧 fixture。
 * 所有公开链路都必须 fail closed，不能把校验原文或内部字段回显给客户。
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
  type WorkflowLibraryPublicV3,
} from "../../../shared/src/index.js";
import {
  sanitizeRole,
  sanitizeScenario,
} from "../../../shared/src/security/sanitizeCustomerFacingText.js";
import type { CronService } from "../cron/service.js";
import type { CronJobCreate, NotifyConfig } from "../cron/types.js";
import type { TenantStore } from "../data/tenants/store.js";
import type { WorkflowDemoStore } from "../data/workflowDemos/store.js";
import {
  createRetryableWorkflowLibraryLoader,
  findLegacyCompatibility,
  loadWorkflowLibraryV3,
  resolveLoadedScenarioSlug,
  type LoadedWorkflowLibraryV3,
} from "../data/scenarios/workflowLibrary.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("scenarios");

const DEFAULT_DATA_PATH = resolve(
  import.meta.dirname,
  "../data/scenarios/scenario-library-v1.json",
);
const DEFAULT_V3_DATA_PATH = resolve(
  import.meta.dirname,
  "../data/scenarios/workflow-library-v3.json",
);

export interface RoleKitPublicConfig {
  v2Enabled?: boolean;
  sanitizePreviewEnabled?: boolean;
  firstDayGuideBar?: {
    enabled?: boolean;
    stageTimeoutMs?: number;
    showOnMobile?: boolean;
  };
  libraryVersion?: "v1" | "v2" | "v3";
}

export interface ScenariosRouterOptions {
  /** 场景库 JSON 路径（测试注入用；缺省为随代码发布的 v1 数据文件） */
  dataPath?: string;
  /** V3 Workflow 权威库路径；false 仅供 legacy fixture 测试显式关闭。 */
  v3DataPath?: string | false;
  /** 仅供定向测试注入已严格解析的 V3 loader。 */
  v3Loader?: () => Promise<LoadedWorkflowLibraryV3>;
  cronService?: CronService;
  roleKit?: RoleKitPublicConfig;
  tenantStore?: Pick<TenantStore, "getSettings">;
  workflowDemoStore?: WorkflowDemoStore;
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
    .map((role) => {
      const report = sanitizeRole({ ...role });
      if (!report.safeToPublish) throw new Error(`scenario role publication blocked: ${role.id}`);
      return report.scenario as ScenarioLibraryResponse["roles"][number];
    });
  const scenarios: ScenarioItem[] = raw.scenarios
    .filter((item) => item.enabled === true)
    .map((item) => {
      const {
        source: _source,
        enabled: _enabled,
        salesPitch: _salesPitch,
        cannotPromise: _cannotPromise,
        ...publicFields
      } = item;
      const report = sanitizeScenario(publicFields);
      if (!report.safeToPublish) throw new Error(`scenario publication blocked: ${item.id}`);
      return report.scenario as ScenarioItem;
    });
  return { roles, scenarios };
}

async function enrichRuntimeWorkflowReplays(
  library: WorkflowLibraryPublicV3,
  store?: WorkflowDemoStore,
): Promise<WorkflowLibraryPublicV3> {
  if (!store) return library;
  const next = structuredClone(library);
  const publishedByCatalog = new Map(
    (await Promise.all(next.scenarios.map(async (scenario) => {
      try {
        return [scenario.id, await store.getLatestPublishedByCatalog(scenario.id)] as const;
      } catch {
        return [scenario.id, null] as const;
      }
    }))).filter((entry) => entry[1] !== null),
  );
  // 目录接口只负责告诉客户“有可核验示例”和公开回放地址。
  // 原始 replay 含运行/事件/证据 ID 与机器状态，只能经专用公开回放投影输出，
  // 不得重新注入目录的宽 demos 容器。
  next.demos = [];
  for (const scenario of next.scenarios) {
    const published = publishedByCatalog.get(scenario.id);
    if (!published) continue;
    scenario.demo = {
      evidenceLevel: "workflow_replay",
      sharePath: `/workflow-replays/${encodeURIComponent(published.snapshot.replayId)}`,
    };
    scenario.launch.sampleAvailable = true;
    if (scenario.readiness === "D0_CURRENT") {
      scenario.launch.startMode = "replay";
      scenario.cta = { primary: "用示例数据体验" };
    }
  }
  return next;
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
  const v3Enabled = options.v3DataPath !== false
    && (options.v3Loader !== undefined
      || typeof options.v3DataPath === "string"
      || options.dataPath === undefined);
  const v3DataPath = typeof options.v3DataPath === "string"
    ? options.v3DataPath
    : DEFAULT_V3_DATA_PATH;
  const router = Router();

  // 进程内缓存：场景库是随代码发布的静态数据，进程生命周期内加载一次即可
  let cache: ScenarioLibraryResponse | null = null;
  let rawCache: ScenarioLibraryFile | null = null;
  // 构造 Router 时立即预热；路由不会等到首个 V3 请求才发现坏文件。
  const getV3Library: (() => Promise<LoadedWorkflowLibraryV3>) | null = v3Enabled
    ? createRetryableWorkflowLibraryLoader(
      options.v3Loader ?? (() => loadWorkflowLibraryV3(v3DataPath)),
    )
    : null;
  // 冷启动预热不阻塞 Server ready；失败会记录真实原因并清掉 rejected cache，
  // 后续请求重新读取。客户面仍只返回稳定错误码，不回显内部路径或 schema。
  void getV3Library?.().catch((error: unknown) => {
    logger.error("Workflow v3 冷启动预热失败，下一次请求将重试", error);
  });

  async function getRawLibrary(): Promise<ScenarioLibraryFile> {
    if (!rawCache) rawCache = await loadScenarioLibraryFile(dataPath);
    return rawCache;
  }

  async function getPublicLibrary(): Promise<ScenarioLibraryResponse> {
    if (!cache) {
      cache = getV3Library
        ? (await getV3Library()).legacy
        : toPublicLibrary(await getRawLibrary());
    }
    return cache;
  }

  router.get("/config", async (req: Request, res: Response) => {
    const roleKit = options.roleKit ?? {};
    const tenantSettings = req.user?.tenantId
      ? options.tenantStore?.getSettings(req.user.tenantId)
      : undefined;
    let workflowCatalogV3 = false;
    if (getV3Library) {
      try {
        await getV3Library();
        workflowCatalogV3 = true;
      } catch (error) {
        logger.error("Workflow v3 配置探测失败", error);
        workflowCatalogV3 = false;
      }
    }
    const configuredVersion = roleKit.libraryVersion;
    const libraryVersion = configuredVersion === "v3" && !workflowCatalogV3
      ? "v2"
      : (configuredVersion ?? (workflowCatalogV3 ? "v3" : "v1"));
    res.json({
      roleKitV2Enabled: roleKit.v2Enabled === true,
      sanitizePreviewEnabled: roleKit.sanitizePreviewEnabled === true,
      firstDayGuideBar: {
        enabled: tenantSettings?.personalization?.firstDayGuideBarEnabled === true,
        stageTimeoutMs: roleKit.firstDayGuideBar?.stageTimeoutMs ?? 5_400_000,
        showOnMobile: roleKit.firstDayGuideBar?.showOnMobile === true,
      },
      libraryVersion,
      capabilities: { workflowCatalogV3 },
    });
  });

  router.get("/v3", async (_req: Request, res: Response) => {
    if (!getV3Library) {
      res.status(500).json({ error: "workflow_catalog_unavailable" });
      return;
    }
    try {
      const loaded = await getV3Library();
      res.json(await enrichRuntimeWorkflowReplays(loaded.public, options.workflowDemoStore));
    } catch (error) {
      logger.error("Workflow v3 目录加载失败", error);
      res.status(500).json({ error: "workflow_catalog_unavailable" });
    }
  });

  router.get("/v3/resolve/:slug", async (req: Request, res: Response) => {
    if (!getV3Library) {
      res.status(500).json({ error: "workflow_catalog_unavailable" });
      return;
    }
    try {
      const resolved = resolveLoadedScenarioSlug(await getV3Library(), req.params.slug ?? "");
      if (!resolved) {
        res.status(404).json({ error: "scenario_not_found" });
        return;
      }
      res.json(resolved);
    } catch (error) {
      logger.error("Workflow v3 路径解析失败", error);
      res.status(500).json({ error: "workflow_catalog_unavailable" });
    }
  });

  router.get("/", async (_req: Request, res: Response) => {
    try {
      res.json(await getPublicLibrary());
    } catch (err) {
      if (getV3Library) {
        res.status(500).json({ error: "workflow_catalog_unavailable" });
        return;
      }
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
      let scenario: ScenarioItemInternal | undefined;
      if (getV3Library) {
        const loaded = await getV3Library();
        const compatibility = findLegacyCompatibility(loaded.internal, body.scenarioId);
        if (!compatibility || !compatibility.legacyCronSupported) {
          res.status(409).json({
            error: "LEGACY_CRON_NOT_SUPPORTED",
            nextAction: "查看工作流或接入我的系统",
          });
          return;
        }
        scenario = loaded.legacy.scenarios.find((item) => item.id === compatibility.legacySlug);
      } else {
        const raw = await getRawLibrary();
        scenario = raw.scenarios.find(
          (item) => item.id === body.scenarioId && item.enabled === true,
        );
        if (!scenario || scenario.mode !== "recurring") {
          res.status(400).json({ error: "scenario_not_recurring" });
          return;
        }
      }
      if (!scenario || scenario.mode !== "recurring") {
        res.status(409).json({ error: "LEGACY_CRON_NOT_SUPPORTED" });
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
      const runOnce = await options.cronService.runNow(created.id);
      res.status(200).json({
        cronJobId: created.id,
        scenarioId: scenario.id,
        createdAt: new Date(created.createdAtMs).toISOString(),
        runOnceImmediately: runOnce.ran,
        ...(runOnce.error ? { runOnceError: runOnce.error } : {}),
      });
    } catch (err) {
      if (getV3Library) {
        res.status(500).json({ error: "workflow_catalog_unavailable" });
        return;
      }
      res.status(500).json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  return router;
}
