import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, statfs } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const SNAPSHOT_ROOT = '/tmp/ky-agent-execution';
const MIN_FREE_BYTES = 512 * 1024 * 1024;
const PREPARE_TIMEOUT_MS = 10 * 60_000;
const DEPENDENCY_PREPARE_TIMEOUT_MS = 4 * 60_000;
const mirrorUpdates = new Map<string, Promise<void>>();

export interface SnapshotExecutionMetadata {
  requested: 'snapshot';
  used: 'snapshot' | 'workspace';
  sourceRevision?: string;
  dirtyFileCount?: number;
  preparationMs: number;
  snapshotMs?: number;
  dependencyMs?: number;
  commandMs?: number;
  totalMs?: number;
  fallbackReason?: string;
}

export interface SnapshotExecutionLease {
  root: string;
  env: Record<string, string>;
  metadata: SnapshotExecutionMetadata;
  cleanup(): Promise<void>;
}

export async function prepareSnapshotExecution(input: {
  workspaceRoot: string;
  command: string;
  signal: AbortSignal;
  env: Record<string, string>;
  progress?: (message: string) => void;
}): Promise<SnapshotExecutionLease> {
  const startedAt = Date.now();
  const fallback = (reason: string): SnapshotExecutionLease => ({
    root: input.workspaceRoot,
    env: input.env,
    metadata: { requested: 'snapshot', used: 'workspace', preparationMs: Date.now() - startedAt, fallbackReason: reason },
    async cleanup() {},
  });

  try {
    throwIfAborted(input.signal);
    const workspaceRoot = await realpath(input.workspaceRoot);
    const gitRoot = (await runFile('git', ['-C', workspaceRoot, 'rev-parse', '--show-toplevel'], {
      signal: input.signal,
      timeoutMs: 30_000,
    })).stdout.toString().trim();
    if (await realpath(gitRoot) !== workspaceRoot) return fallback('workspace_root_is_not_git_root');
    const disk = await statfs('/tmp');
    if (Number(disk.bavail) * Number(disk.bsize) < MIN_FREE_BYTES) return fallback('ephemeral_storage_below_512m');

    const workspaceKey = createHash('sha256').update(workspaceRoot).digest('hex').slice(0, 16);
    const cacheRoot = join(SNAPSHOT_ROOT, workspaceKey);
    const mirrorPath = join(cacheRoot, 'mirror.git');
    const runsRoot = join(cacheRoot, 'runs');
    const packageCacheRoot = join(cacheRoot, 'package-cache');
    await mkdir(runsRoot, { recursive: true });
    await mkdir(packageCacheRoot, { recursive: true });
    input.progress?.('正在把当前工作区快照准备到容器临时盘');

    const revision = (await runFile('git', ['-C', workspaceRoot, 'rev-parse', 'HEAD'], {
      signal: input.signal,
      timeoutMs: 30_000,
    })).stdout.toString().trim();
    await updateMirror({ workspaceRoot, mirrorPath, revision, signal: input.signal });

    const runRoot = await mkdtemp(join(runsRoot, 'run-'));
    try {
      await runFile('git', ['clone', '--shared', '--no-checkout', '--quiet', mirrorPath, runRoot], {
        signal: input.signal,
        timeoutMs: PREPARE_TIMEOUT_MS,
      });
      await runFile('git', ['-C', runRoot, 'checkout', '--detach', '--force', '--quiet', revision], {
        signal: input.signal,
        timeoutMs: PREPARE_TIMEOUT_MS,
      });
      const dirtyPaths = await currentOverlayPaths(workspaceRoot, input.signal);
      for (const path of dirtyPaths) await overlayPath(workspaceRoot, runRoot, path);
      await copyIgnoredRuntimeFiles(workspaceRoot, runRoot);

      const snapshotEnv = {
        ...input.env,
        npm_config_store_dir: join(packageCacheRoot, 'pnpm-store'),
        npm_config_cache: join(packageCacheRoot, 'npm'),
        YARN_CACHE_FOLDER: join(packageCacheRoot, 'yarn'),
        PIP_CACHE_DIR: join(packageCacheRoot, 'pip'),
      };
      const dependencyStartedAt = Date.now();
      const dependencyBootstrapped = await ensureNodeDependencies({
        runRoot,
        command: input.command,
        env: snapshotEnv,
        signal: input.signal,
        progress: input.progress,
      });
      const dependencyMs = dependencyBootstrapped ? Date.now() - dependencyStartedAt : 0;
      return {
        root: runRoot,
        env: snapshotEnv,
        metadata: {
          requested: 'snapshot',
          used: 'snapshot',
          sourceRevision: revision,
          dirtyFileCount: dirtyPaths.length,
          preparationMs: Date.now() - startedAt,
          snapshotMs: dependencyStartedAt - startedAt,
          dependencyMs,
        },
        async cleanup() {
          try {
            const localToolResults = join(runRoot, 'tmp', 'tool-results');
            if (await pathExists(localToolResults)) {
              await cp(localToolResults, join(workspaceRoot, 'tmp', 'tool-results'), {
                recursive: true,
                force: true,
                preserveTimestamps: true,
              });
            }
          } finally {
            await rm(runRoot, { recursive: true, force: true });
          }
        },
      };
    } catch (err) {
      await rm(runRoot, { recursive: true, force: true });
      throw err;
    }
  } catch (err) {
    if (input.signal.aborted) throw err;
    return fallback(compactError(err));
  }
}

async function updateMirror(input: {
  workspaceRoot: string;
  mirrorPath: string;
  revision: string;
  signal: AbortSignal;
}): Promise<void> {
  const previous = mirrorUpdates.get(input.mirrorPath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    if (!(await pathExists(join(input.mirrorPath, 'HEAD')))) {
      const temporary = `${input.mirrorPath}.tmp-${process.pid}-${Date.now()}`;
      await rm(temporary, { recursive: true, force: true });
      try {
        await runFile('git', ['clone', '--mirror', '--no-hardlinks', '--quiet', input.workspaceRoot, temporary], {
          signal: input.signal,
          timeoutMs: PREPARE_TIMEOUT_MS,
        });
        await mkdir(dirname(input.mirrorPath), { recursive: true });
        await rename(temporary, input.mirrorPath);
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    await runFile('git', [
      '--git-dir', input.mirrorPath,
      'fetch', '--force', '--no-tags', input.workspaceRoot,
      `${input.revision}:refs/ky-agent/source`,
    ], { signal: input.signal, timeoutMs: PREPARE_TIMEOUT_MS });
  });
  mirrorUpdates.set(input.mirrorPath, current);
  try {
    await current;
  } finally {
    if (mirrorUpdates.get(input.mirrorPath) === current) mirrorUpdates.delete(input.mirrorPath);
  }
}

async function currentOverlayPaths(workspaceRoot: string, signal: AbortSignal): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    runFile('git', ['-C', workspaceRoot, 'diff', '--name-only', '--no-renames', '-z', 'HEAD', '--'], {
      signal,
      timeoutMs: 60_000,
      encoding: 'buffer',
    }),
    runFile('git', ['-C', workspaceRoot, 'ls-files', '--others', '--exclude-standard', '-z'], {
      signal,
      timeoutMs: 60_000,
      encoding: 'buffer',
    }),
  ]);
  return [...new Set([...nulPaths(tracked.stdout), ...nulPaths(untracked.stdout)])].sort();
}

async function overlayPath(workspaceRoot: string, runRoot: string, relativePath: string): Promise<void> {
  const source = safeChildPath(workspaceRoot, relativePath);
  const target = safeChildPath(runRoot, relativePath);
  await rm(target, { recursive: true, force: true });
  if (!(await pathExists(source))) return;
  await mkdir(dirname(target), { recursive: true });
  const sourceStat = await lstat(source);
  await cp(source, target, {
    recursive: sourceStat.isDirectory(),
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}

async function copyIgnoredRuntimeFiles(workspaceRoot: string, runRoot: string): Promise<void> {
  const names = (await readdir(workspaceRoot)).filter((name) => name === '.env' || name.startsWith('.env.'));
  for (const name of names) await overlayPath(workspaceRoot, runRoot, name);
}

async function ensureNodeDependencies(input: {
  runRoot: string;
  command: string;
  env: Record<string, string>;
  signal: AbortSignal;
  progress?: (message: string) => void;
}): Promise<boolean> {
  if (!(await pathExists(join(input.runRoot, 'package.json')))) return false;
  const pnpmLock = join(input.runRoot, 'pnpm-lock.yaml');
  const npmLock = join(input.runRoot, 'package-lock.json');
  if (await pathExists(pnpmLock)) {
    if (commandInstallsDependencies(input.command, 'pnpm')) return false;
    input.progress?.('正在容器临时盘复用 pnpm 缓存准备依赖');
    await runFile('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--reporter=append-only'], {
      cwd: input.runRoot,
      env: { ...input.env, NODE_ENV: 'development' },
      signal: input.signal,
      timeoutMs: DEPENDENCY_PREPARE_TIMEOUT_MS,
    });
    return true;
  }
  if (await pathExists(npmLock)) {
    if (commandInstallsDependencies(input.command, 'npm')) return false;
    input.progress?.('正在容器临时盘复用 npm 缓存准备依赖');
    await runFile('npm', ['ci', '--prefer-offline', '--no-audit', '--no-fund'], {
      cwd: input.runRoot,
      env: { ...input.env, NODE_ENV: 'development' },
      signal: input.signal,
      timeoutMs: DEPENDENCY_PREPARE_TIMEOUT_MS,
    });
    return true;
  }
  return false;
}

function commandInstallsDependencies(command: string, packageManager: 'pnpm' | 'npm'): boolean {
  const escaped = packageManager === 'pnpm' ? 'pnpm' : 'npm';
  return new RegExp(`(?:^|[;&|]\\s*)(?:corepack\\s+)?${escaped}\\s+(?:i|install|ci)(?:\\s|$)`).test(command);
}

function safeChildPath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\0')) throw new Error('invalid snapshot path');
  const target = resolve(root, relativePath);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) throw new Error(`snapshot path escapes workspace: ${relativePath}`);
  return target;
}

function nulPaths(value: string | Buffer): string[] {
  return (Buffer.isBuffer(value) ? value.toString('utf-8') : value).split('\0').filter(Boolean);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('snapshot preparation aborted');
}

function compactError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 500) || 'snapshot_prepare_failed';
}

interface RunFileOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  timeoutMs: number;
  encoding?: 'utf8' | 'buffer';
}

async function runFile(
  file: string,
  args: string[],
  options: RunFileOptions,
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  return await new Promise((resolvePromise, reject) => {
    execFile(file, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      timeout: options.timeoutMs,
      encoding: options.encoding === 'buffer' ? 'buffer' : 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${file} ${args[0] ?? ''} failed: ${String(stderr || error.message).trim().slice(0, 2_000)}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}
