/**
 * 一致性测试用的 PostgreSQL：`--pg docker` 起一个**自己的**临时容器，用完必删。
 *
 * 纪律：随机高位端口（绝不用 5432）、容器名带随机后缀（不与别人的容器撞名）、
 * 只删自己创建的容器。
 */
import { spawnSync } from 'node:child_process';

import { freePort, randomSuffix } from './ports.js';

export const POSTGRES_IMAGE = 'postgres:16-alpine';
export const CONTAINER_PREFIX = 'ky-app-doctor-';

export interface PgHandle {
  url: string;
  kind: 'docker' | 'url';
  /** docker 模式下的容器名。 */
  containerName?: string;
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

/** 已有的 URL 直接用（`--pg url` / `TEST_DATABASE_URL`）。 */
export function usePgUrl(url: string): PgHandle {
  return { url, kind: 'url', stop: async () => undefined };
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
    stop: async () => {
      docker(['rm', '-f', containerName], 60_000);
    },
  };

  try {
    await waitForPostgres(containerName);
  } catch (error) {
    await handle.stop();
    throw error;
  }
  return handle;
}

/** 轮询 `pg_isready`，最长 60 秒。 */
async function waitForPostgres(containerName: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const probe = docker(
      ['exec', containerName, 'pg_isready', '-U', 'kyapp', '-d', 'kyapp_doctor'],
      15_000,
    );
    if (probe.code === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`postgres 容器 ${containerName} 60 秒内没有就绪：${probe.stderr.trim()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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
