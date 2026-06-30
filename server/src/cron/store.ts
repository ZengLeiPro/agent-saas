/**
 * Cron 任务存储模块
 */
import * as fs from "fs/promises";
import * as path from "path";
import os from "os";
import type { CronJob, CronJobState, CronStoreFile } from "./types.js";
import { cronLogger } from "../utils/logger.js";

const STORE_VERSION = 2;
const LAST_RUN_STATE_KEYS: ReadonlyArray<keyof CronJobState> = [
  "lastRunAtMs",
  "lastStatus",
  "lastError",
  "lastDurationMs",
  "lastOutput",
];

export interface CronStoreOptions {
  storePath: string; // jobs.json 路径
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function omitLastRunState(state: CronJobState = {}): CronJobState {
  const next = { ...state };
  for (const key of LAST_RUN_STATE_KEYS) {
    delete next[key];
  }
  return next;
}

function omitLastRunStateFromJob(job: CronJob): CronJob {
  return {
    ...job,
    state: omitLastRunState(job.state),
  };
}

export async function loadJobs(opts: CronStoreOptions): Promise<CronJob[]> {
  try {
    const content = await fs.readFile(opts.storePath, "utf-8");
    const data = JSON.parse(content) as CronStoreFile;

    if (data.version === 1) {
      cronLogger.info(
        `Migrating store from v1 to v2 (adding owner tracking). ${data.jobs?.length ?? 0} existing jobs will have no owner.`
      );
    } else if (data.version !== STORE_VERSION) {
      cronLogger.warn(
        `Store version mismatch: expected ${STORE_VERSION}, got ${data.version}`
      );
    }

    return Array.isArray(data.jobs) ? data.jobs.map(omitLastRunStateFromJob) : [];
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

export async function saveJobs(
  jobs: CronJob[],
  opts: CronStoreOptions
): Promise<void> {
  const data: CronStoreFile = {
    version: STORE_VERSION,
    jobs: jobs.map(omitLastRunStateFromJob),
  };

  await ensureDir(path.dirname(opts.storePath));

  const tempPath = `${opts.storePath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tempPath, opts.storePath);
}

/**
 * 解析存储路径（支持相对路径和 ~ 扩展）
 */
export function resolveStorePath(storePath: string, basePath: string): string {
  if (storePath.startsWith("~")) {
    return path.resolve(storePath.replace("~", os.homedir()));
  }
  if (path.isAbsolute(storePath)) return storePath;
  return path.resolve(basePath, storePath);
}
