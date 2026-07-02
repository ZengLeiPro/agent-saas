/**
 * 场景库路由
 *
 * GET /api/scenarios —— 返回按岗位分组的预置场景卡片库 { roles, scenarios }。
 * 所有登录用户可读（走全局 /api 鉴权中间件，无 admin 限制）。
 *
 * 数据源为随代码发布的静态 JSON（src/data/scenarios/scenario-library-v1.json）。
 * 下发前必须：
 *  1. 过滤掉 enabled !== true 的条目（未上架场景不出库）；
 *  2. 剥离 source 字段（内部溯源信息，严禁暴露给前端/客户）。
 */
import { Router } from "express";
import type { Request, Response } from "express";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ScenarioItem,
  ScenarioLibraryResponse,
  ScenarioRole,
} from "../../../shared/src/types/scenario.js";

/** JSON 原始条目：比公开类型多内部字段（source 溯源 / enabled 上架开关） */
interface RawScenarioItem extends ScenarioItem {
  source?: string;
  enabled?: boolean;
}

interface ScenarioLibraryFile {
  version?: number;
  updatedAt?: string;
  roles?: ScenarioRole[];
  scenarios?: RawScenarioItem[];
}

const DEFAULT_DATA_PATH = resolve(
  import.meta.dirname,
  "../data/scenarios/scenario-library-v1.json",
);

export interface ScenariosRouterOptions {
  /** 场景库 JSON 路径（测试注入用；缺省为随代码发布的 v1 数据文件） */
  dataPath?: string;
}

export function createScenariosRouter(
  options: ScenariosRouterOptions = {},
): Router {
  const dataPath = options.dataPath ?? DEFAULT_DATA_PATH;
  const router = Router();

  // 进程内缓存：场景库是随代码发布的静态数据，进程生命周期内加载一次即可
  let cache: ScenarioLibraryResponse | null = null;

  router.get("/", async (_req: Request, res: Response) => {
    try {
      if (!cache) {
        const raw = JSON.parse(
          await readFile(dataPath, "utf-8"),
        ) as ScenarioLibraryFile;
        // 岗位按 sort 升序排好再下发，前端直接按序渲染 tab
        const roles = [...(raw.roles ?? [])].sort((a, b) => a.sort - b.sort);
        const scenarios: ScenarioItem[] = (raw.scenarios ?? [])
          .filter((item) => item.enabled === true)
          // 剥离内部字段：source（溯源）不得出库；enabled 过滤后无意义，一并剥离
          .map(({ source: _source, enabled: _enabled, ...publicFields }) => publicFields);
        cache = { roles, scenarios };
      }
      res.json(cache);
    } catch (err) {
      res
        .status(500)
        .json({ error: String(err instanceof Error ? err.message : err) });
    }
  });

  return router;
}
