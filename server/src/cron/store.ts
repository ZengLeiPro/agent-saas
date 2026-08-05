/**
 * Cron 任务存储模块
 */
import * as fs from "fs/promises";
import * as path from "path";
import { randomUUID } from "crypto";
import os from "os";
import type { CronJob, CronJobState, CronStoreFile } from "./types.js";
import { cronLogger } from "../utils/logger.js";

const STORE_VERSION = 2;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 20;
const LAST_RUN_STATE_KEYS: ReadonlyArray<keyof CronJobState> = [
  "lastRunAtMs",
  "lastStatus",
  "lastError",
  "lastDurationMs",
  "lastOutput",
];

export interface CronStoreOptions {
  storePath: string; // jobs.json 路径
  /** 等待另一个进程释放写锁的最长时间。 */
  lockTimeoutMs?: number;
  /** 心跳间隔计算兼容项；文件锁本身不做基于时间的危险接管。 */
  staleLockMs?: number;
  /** 获取锁失败后的重试间隔。 */
  lockRetryMs?: number;
  /** 生产 PG advisory lock；提供时替代本地文件锁并在进程崩溃时自动释放。 */
  withLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface CronJobsMutationResult<T> {
  /** mutation 提交后的完整最新快照。 */
  jobs: CronJob[];
  result: T;
}

export type CronJobsMutator<T> = (jobs: CronJob[]) => T | Promise<T>;

interface HeldLock {
  lockPath: string;
  ownerPath: string;
  ownerHandle: fs.FileHandle;
  token: string;
  heartbeat: ReturnType<typeof setInterval>;
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

function serializeJobs(jobs: CronJob[]): string {
  const data: CronStoreFile = {
    version: STORE_VERSION,
    jobs: jobs.map(omitLastRunStateFromJob),
  };
  return JSON.stringify(data, null, 2);
}

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLock(opts: CronStoreOptions): Promise<HeldLock> {
  const lockPath = `${opts.storePath}.lock`;
  const ownerPath = lockPath;
  const timeoutMs = Math.max(0, opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const staleLockMs = Math.max(1, opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS);
  const retryMs = Math.max(1, opts.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS);
  const deadline = Date.now() + timeoutMs;
  const token = `${process.pid}-${randomUUID()}`;
  const candidatePath = `${lockPath}.candidate-${token}`;

  await ensureDir(path.dirname(opts.storePath));
  let ownerHandle: fs.FileHandle | undefined;

  try {
    ownerHandle = await fs.open(candidatePath, "wx");
    await ownerHandle.writeFile(
      JSON.stringify({
        token,
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAtMs: Date.now(),
      }),
      "utf-8",
    );
    await ownerHandle.sync();

    for (;;) {
      try {
        // link() is an atomic no-replace publish: the visible lock never exists
        // without complete owner metadata, and an existing lock is never
        // overwritten. A crash before publish leaves only an inert candidate.
        await fs.link(candidatePath, lockPath);
        await fs.rm(candidatePath, { force: true });
        await fsyncDirectoryBestEffort(path.dirname(lockPath));

        const heartbeatMs = Math.max(10, Math.floor(staleLockMs / 3));
        const heartbeat = setInterval(() => {
          const now = new Date();
          ownerHandle!.utimes(now, now).catch(() => {});
        }, heartbeatMs);
        heartbeat.unref?.();
        return { lockPath, ownerPath, ownerHandle, token, heartbeat };
      } catch (err) {
        if (errorCode(err) !== "EEXIST") throw err;
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring cron store lock: ${lockPath}`);
      }
      await sleep(Math.min(retryMs, Math.max(1, deadline - Date.now())));
    }
  } catch (err) {
    await ownerHandle?.close().catch(() => {});
    await fs.rm(candidatePath, { force: true }).catch(() => {});
    throw err;
  }
}

async function releaseLock(lock: HeldLock): Promise<void> {
  clearInterval(lock.heartbeat);
  await lock.ownerHandle.close().catch(() => {});
  try {
    const content = await fs.readFile(lock.ownerPath, "utf-8");
    const owner = JSON.parse(content) as { token?: string };
    if (owner.token !== lock.token) return;
    await fs.rm(lock.lockPath, { recursive: true, force: true });
  } catch (err) {
    // A stale-lock takeover may already have moved our directory. Never remove
    // a lock whose ownership can no longer be proven.
    if (errorCode(err) !== "ENOENT") {
      cronLogger.warn(`Failed to release cron store lock ${lock.lockPath}: ${String(err)}`);
    }
  }
}

async function fsyncDirectoryBestEffort(dirPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch {
    // Some filesystems/platforms do not support fsync on a directory.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertLockOwnership(lock: HeldLock): Promise<void> {
  const now = new Date();
  await lock.ownerHandle.utimes(now, now);
  const content = await fs.readFile(lock.ownerPath, "utf-8");
  const owner = JSON.parse(content) as { token?: string };
  if (owner.token !== lock.token) {
    throw new Error(`Cron store lock ownership lost: ${lock.lockPath}`);
  }
}

async function atomicWriteJobs(
  jobs: CronJob[],
  opts: CronStoreOptions,
  lock?: HeldLock,
): Promise<void> {
  const dirPath = path.dirname(opts.storePath);
  const tempPath = `${opts.storePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle: fs.FileHandle | undefined;

  await ensureDir(dirPath);
  try {
    handle = await fs.open(tempPath, "wx");
    await handle.writeFile(serializeJobs(jobs), "utf-8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    // File-lock mode verifies ownership before publish. Production PG mode
    // holds a crash-safe advisory lock around this entire operation.
    if (lock) await assertLockOwnership(lock);
    await fs.rename(tempPath, opts.storePath);
    await fsyncDirectoryBestEffort(dirPath);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
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
  } catch (err) {
    if (errorCode(err) === "ENOENT") return [];
    throw err;
  }
}

/**
 * 在跨进程写锁内读取最新快照、执行目标 mutation，并原子提交完整快照。
 * 支持 `(mutator, opts)`；同时兼容 `(opts, mutator)` 便于调用方绑定配置。
 */
export async function mutateJobs<T>(
  mutator: CronJobsMutator<T>,
  opts: CronStoreOptions,
): Promise<CronJobsMutationResult<T>>;
export async function mutateJobs<T>(
  opts: CronStoreOptions,
  mutator: CronJobsMutator<T>,
): Promise<CronJobsMutationResult<T>>;
export async function mutateJobs<T>(
  first: CronStoreOptions | CronJobsMutator<T>,
  second: CronStoreOptions | CronJobsMutator<T>,
): Promise<CronJobsMutationResult<T>> {
  const opts = typeof first === "function" ? second as CronStoreOptions : first;
  const mutator = typeof first === "function" ? first : second as CronJobsMutator<T>;
  const operation = async (lock?: HeldLock): Promise<CronJobsMutationResult<T>> => {
    const jobs = await loadJobs(opts);
    const result = await mutator(jobs);
    await atomicWriteJobs(jobs, opts, lock);
    return { jobs, result };
  };

  if (opts.withLock) return opts.withLock(() => operation());

  const lock = await acquireLock(opts);
  try {
    return await operation(lock);
  } finally {
    await releaseLock(lock);
  }
}

export async function saveJobs(
  jobs: CronJob[],
  opts: CronStoreOptions
): Promise<void> {
  if (opts.withLock) {
    await opts.withLock(() => atomicWriteJobs(jobs, opts));
    return;
  }

  const lock = await acquireLock(opts);
  try {
    await atomicWriteJobs(jobs, opts, lock);
  } finally {
    await releaseLock(lock);
  }
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
