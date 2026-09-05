/**
 * 一致性测试用的 PostgreSQL：`--pg docker` 起一个**自己的**临时容器，用完必删。
 *
 * 纪律：随机高位端口（绝不用 5432）、容器名带随机后缀（不与别人的容器撞名）、
 * 只删自己创建的容器。
 *
 * 就绪判据（C-fix-01）：**不用容器内的 `pg_isready`**。`pg_isready` 走容器内 unix socket，
 * 而 postgres 官方镜像的初始化脚本会先起一次「只监听 socket」的临时实例、跑完 initdb 再重启，
 * 因此 socket 就绪明显早于宿主机 TCP 端口真正可连；据此判就绪会让被测项目首连撞上
 * `ECONNRESET` / `Connection terminated` / `the database system is starting up`。
 * 现在改成从宿主机用 `pg` 客户端对最终的 `DATABASE_URL` 真连并 `SELECT 1`，
 * 连续两次成功才算就绪。外部 `--database-url` 走同一条探测。
 */
import { spawnSync } from 'node:child_process';

import { Client } from 'pg';

import { freePort, randomSuffix } from './ports.js';

export const POSTGRES_IMAGE = 'postgres:16-alpine';
export const CONTAINER_PREFIX = 'ky-app-doctor-';

/** 就绪探测：总超时 60 s，失败退避 500 ms，需要连续 2 次成功。 */
export const READY_TIMEOUT_MS = 60_000;
const PROBE_BACKOFF_MS = 500;
/** 两次成功之间也隔一小段，避免同一瞬间的两次探测其实是同一个连接窗口。 */
const PROBE_SUCCESS_GAP_MS = 200;
const REQUIRED_CONSECUTIVE_OK = 2;
const PROBE_CONNECT_TIMEOUT_MS = 3_000;

export interface PgHandle {
  url: string;
  kind: 'docker' | 'url';
  /** docker 模式下的容器名。 */
  containerName?: string;
  /**
   * 就绪信号。多次调用只真正探测一次（记忆化），doctor 的两个 worker 共用同一个结果，
   * 谁都不各自猜「大概好了」。
   */
  ready(): Promise<void>;
  stop(): Promise<void>;
}

function docker(
  args: string[],
  timeoutMs = 60_000,
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: timeoutMs });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error === undefined ? '' : String(result.error.message)),
  };
}

/** 本机是否有可用的 docker（命令存在且守护进程在跑）。 */
export function dockerAvailable(): boolean {
  return docker(['version', '--format', '{{.Server.Version}}'], 15_000).code === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 记忆化的就绪信号工厂。 */
function memoizeReady(run: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | null = null;
  return () => {
    pending ??= run();
    return pending;
  };
}

/** 已有的 URL 直接用（`--pg url` / `TEST_DATABASE_URL`）；就绪探测与 docker 模式完全一致。 */
export function usePgUrl(
  url: string,
  options: { log?: (line: string) => void; timeoutMs?: number } = {},
): PgHandle {
  return {
    url,
    kind: 'url',
    ready: memoizeReady(async () => {
      await waitForPostgresReady(url, { log: options.log, timeoutMs: options.timeoutMs });
    }),
    stop: async () => undefined,
  };
}

/**
 * 起一个临时 postgres 容器。
 * 用户名 / 库名固定 `kyapp` / `kyapp_doctor`（库名带 `doctor`，供 §9.3-6「只在测试库执行」自检）。
 */
export async function startDockerPostgres(
  options: { log?: (line: string) => void } = {},
): Promise<PgHandle> {
  const log = options.log ?? (() => undefined);
  const port = await freePort();
  const containerName = `${CONTAINER_PREFIX}${randomSuffix()}`;
  log(`启动测试数据库容器 ${containerName}（127.0.0.1:${String(port)} → 5432）`);
  const run = docker(
    [
      'run',
      '--rm',
      '-d',
      '--name',
      containerName,
      '-e',
      'POSTGRES_USER=kyapp',
      '-e',
      'POSTGRES_PASSWORD=kyapp',
      '-e',
      'POSTGRES_DB=kyapp_doctor',
      '-p',
      `127.0.0.1:${String(port)}:5432`,
      POSTGRES_IMAGE,
    ],
    180_000,
  );
  if (run.code !== 0) {
    throw new Error(`启动 postgres 容器失败：${run.stderr.trim()}`);
  }

  const url = `postgresql://kyapp:kyapp@127.0.0.1:${String(port)}/kyapp_doctor`;
  const handle: PgHandle = {
    url,
    kind: 'docker',
    containerName,
    ready: memoizeReady(async () => {
      await waitForPostgresReady(url, { containerName, log });
    }),
    stop: async () => {
      docker(['rm', '-f', containerName], 60_000);
    },
  };

  try {
    await handle.ready();
  } catch (error) {
    await handle.stop();
    throw error;
  }
  return handle;
}

/** 单次探测：连上去跑一条 `SELECT 1`，成功返回 `null`，失败返回错误摘要。 */
async function probeOnce(url: string): Promise<string | null> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: PROBE_CONNECT_TIMEOUT_MS,
    application_name: 'ky-app-doctor-probe',
  });
  // 连接被服务端重置时 pg 会 emit error；不接住会变成未捕获异常。
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.query('SELECT 1');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    try {
      await client.end();
    } catch {
      // 关闭失败无所谓，下一轮重新建连接。
    }
  }
}

/**
 * 等 PostgreSQL 从**宿主机**真的可连：对 `url` 循环 `SELECT 1`，连续
 * `REQUIRED_CONSECUTIVE_OK` 次成功才算就绪；单次失败退避 500 ms；总超时 60 s。
 * 超时报错时附上容器最后 50 行日志（docker 模式）。
 */
export async function waitForPostgresReady(
  url: string,
  options: { containerName?: string; log?: (line: string) => void; timeoutMs?: number } = {},
): Promise<void> {
  const log = options.log ?? (() => undefined);
  const deadline = Date.now() + (options.timeoutMs ?? READY_TIMEOUT_MS);
  let consecutiveOk = 0;
  let attempts = 0;
  let lastError = '（没有拿到错误信息）';
  const startedAt = Date.now();

  for (;;) {
    attempts += 1;
    const failure = await probeOnce(url);
    if (failure === null) {
      consecutiveOk += 1;
      if (consecutiveOk >= REQUIRED_CONSECUTIVE_OK) {
        log(
          `数据库就绪：连续 ${String(REQUIRED_CONSECUTIVE_OK)} 次 SELECT 1 成功` +
            `（探测 ${String(attempts)} 次，耗时 ${String(Date.now() - startedAt)} ms）`,
        );
        return;
      }
      if (Date.now() > deadline) break;
      await sleep(PROBE_SUCCESS_GAP_MS);
      continue;
    }
    consecutiveOk = 0;
    lastError = failure;
    if (Date.now() > deadline) break;
    await sleep(PROBE_BACKOFF_MS);
  }

  const parts = [
    `数据库在 ${String(options.timeoutMs ?? READY_TIMEOUT_MS)} ms 内没有就绪` +
      `（探测 ${String(attempts)} 次）：${lastError}`,
  ];
  if (options.containerName !== undefined) {
    parts.push(containerTailLogs(options.containerName));
  }
  throw new Error(parts.join('\n'));
}

/** 取容器最后 50 行日志，供就绪失败时定位。 */
export function containerTailLogs(containerName: string, tail = 50): string {
  const logs = docker(['logs', '--tail', String(tail), containerName], 30_000);
  const text = `${logs.stdout}${logs.stderr}`.trim();
  if (text === '') return `容器 ${containerName} 最后 ${String(tail)} 行日志：（空）`;
  return `容器 ${containerName} 最后 ${String(tail)} 行日志：\n${text}`;
}

/** §9.3-6：写能力测试只在测试库执行。库名必须能被认出是测试库。 */
export function looksLikeTestDatabase(url: string): boolean {
  try {
    const parsed = new URL(url);
    const database = parsed.pathname.replace(/^\//u, '').toLowerCase();
    return /(?:test|doctor|ci|tmp)/u.test(database);
  } catch {
    return false;
  }
}
