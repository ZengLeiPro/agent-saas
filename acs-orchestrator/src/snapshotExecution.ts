import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { ensureSnapshotNodeDependencies } from './snapshotDependencyCache.js';

const SNAPSHOT_ROOT = '/tmp/ky-agent-execution';
const MIN_FREE_BYTES = 512 * 1024 * 1024;
const PREPARE_TIMEOUT_MS = 10 * 60_000;
const mirrorUpdates = new Map<string, Promise<void>>();

export interface SnapshotExecutionMetadata {
  requested: 'snapshot';
  used: 'snapshot' | 'workspace';
  sourceRevision?: string;
  dirtyFileCount?: number;
  preparationMs: number;
  snapshotMs?: number;
  dependencyMs?: number;
  dependencyCacheHit?: boolean;
  repositoryPath?: string;
  sourceCwd?: string;
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
  snapshotCwd?: string;
  signal: AbortSignal;
  env: Record<string, string>;
  progress?: (message: string) => void;
}): Promise<SnapshotExecutionLease> {
  const startedAt = Date.now();
  let fallbackRoot = input.workspaceRoot;
  let repositoryPath: string | undefined;
  let sourceCwd: string | undefined;
  const fallback = (reason: string): SnapshotExecutionLease => {
    input.progress?.(`容器临时盘快照不可用，已回退持久工作区：${reason}`);
    return {
      root: fallbackRoot,
      env: input.env,
      metadata: {
        requested: 'snapshot',
        used: 'workspace',
        preparationMs: Date.now() - startedAt,
        ...(repositoryPath ? { repositoryPath } : {}),
        ...(sourceCwd ? { sourceCwd } : {}),
        fallbackReason: reason,
      },
      async cleanup() {},
    };
  };

  try {
    throwIfAborted(input.signal);
    const workspaceRoot = await realpath(input.workspaceRoot);
    const explicitCwd = input.snapshotCwd
      ? await resolveWorkspaceDirectory(workspaceRoot, input.snapshotCwd)
      : undefined;
    if (explicitCwd) {
      fallbackRoot = explicitCwd;
      sourceCwd = workspaceRelativePath(workspaceRoot, explicitCwd);
    }
    const inferredCwd = !explicitCwd ? inferLeadingCommandCwd(input.command) : undefined;
    const inferredDirectory = inferredCwd
      ? await resolveWorkspaceDirectory(workspaceRoot, inferredCwd).catch(() => undefined)
      : undefined;
    const repositoryHint = explicitCwd ?? inferredDirectory ?? workspaceRoot;
    let gitRoot = await findContainingGitRoot(repositoryHint, input.signal);
    let autoDiscovered = false;
    if (!gitRoot && !explicitCwd && !inferredDirectory) {
      const repositories = await discoverNestedGitRoots(workspaceRoot);
      if (repositories.length > 1) return fallback('multiple_git_repositories_require_snapshotCwd');
      gitRoot = repositories[0];
      autoDiscovered = Boolean(gitRoot);
    }
    if (!gitRoot) return fallback('git_repository_not_found');
    gitRoot = await realpath(gitRoot);
    assertInsideWorkspace(workspaceRoot, gitRoot, 'Git repository');
    repositoryPath = workspaceRelativePath(workspaceRoot, gitRoot);

    const sourceExecutionRoot = explicitCwd
      ?? (autoDiscovered ? gitRoot : workspaceRoot);
    fallbackRoot = sourceExecutionRoot;
    sourceCwd = workspaceRelativePath(workspaceRoot, sourceExecutionRoot);
    const disk = await statfs('/tmp');
    if (Number(disk.bavail) * Number(disk.bsize) < MIN_FREE_BYTES) return fallback('ephemeral_storage_below_512m');

    const workspaceKey = createHash('sha256').update(gitRoot).digest('hex').slice(0, 16);
    const cacheRoot = join(SNAPSHOT_ROOT, workspaceKey);
    const mirrorPath = join(cacheRoot, 'mirror.git');
    const runsRoot = join(cacheRoot, 'runs');
    const packageCacheRoot = join(cacheRoot, 'package-cache');
    await mkdir(runsRoot, { recursive: true });
    await mkdir(packageCacheRoot, { recursive: true });
    input.progress?.('正在把当前工作区快照准备到容器临时盘');

    const revision = (await runFile('git', ['-C', gitRoot, 'rev-parse', 'HEAD'], {
      signal: input.signal,
      timeoutMs: 30_000,
    })).stdout.toString().trim();
    await updateMirror({ workspaceRoot: gitRoot, mirrorPath, revision, signal: input.signal });

    const runWorkspaceRoot = await mkdtemp(join(runsRoot, 'run-'));
    const runRepositoryRoot = repositoryPath === '.'
      ? runWorkspaceRoot
      : safeChildPath(runWorkspaceRoot, repositoryPath);
    try {
      await mkdir(dirname(runRepositoryRoot), { recursive: true });
      await runFile('git', ['clone', '--shared', '--no-checkout', '--quiet', mirrorPath, runRepositoryRoot], {
        signal: input.signal,
        timeoutMs: PREPARE_TIMEOUT_MS,
      });
      await runFile('git', ['-C', runRepositoryRoot, 'checkout', '--detach', '--force', '--quiet', revision], {
        signal: input.signal,
        timeoutMs: PREPARE_TIMEOUT_MS,
      });
      const dirtyPaths = await currentOverlayPaths(gitRoot, input.signal);
      for (const path of dirtyPaths) await overlayPath(gitRoot, runRepositoryRoot, path);
      await copyIgnoredRuntimeFiles(gitRoot, runRepositoryRoot);

      const snapshotEnv = {
        ...input.env,
        npm_config_store_dir: join(packageCacheRoot, 'pnpm-store'),
        npm_config_cache: join(packageCacheRoot, 'npm'),
        YARN_CACHE_FOLDER: join(packageCacheRoot, 'yarn'),
        PIP_CACHE_DIR: join(packageCacheRoot, 'pip'),
      };
      const dependencyStartedAt = Date.now();
      const dependency = await ensureSnapshotNodeDependencies({
        runRoot: runRepositoryRoot,
        command: input.command,
        packageCacheRoot,
        env: snapshotEnv,
        signal: input.signal,
        progress: input.progress,
      });
      const dependencyMs = dependency.prepared ? Date.now() - dependencyStartedAt : 0;
      const executionRoot = sourceCwd === '.'
        ? runWorkspaceRoot
        : safeChildPath(runWorkspaceRoot, sourceCwd);
      return {
        root: executionRoot,
        env: snapshotEnv,
        metadata: {
          requested: 'snapshot',
          used: 'snapshot',
          sourceRevision: revision,
          dirtyFileCount: dirtyPaths.length,
          repositoryPath,
          sourceCwd,
          preparationMs: Date.now() - startedAt,
          snapshotMs: dependencyStartedAt - startedAt,
          dependencyMs,
          ...(dependency.cacheHit !== undefined ? { dependencyCacheHit: dependency.cacheHit } : {}),
        },
        async cleanup() {
          try {
            const localToolResults = join(executionRoot, 'tmp', 'tool-results');
            if (await pathExists(localToolResults)) {
              await cp(localToolResults, join(sourceExecutionRoot, 'tmp', 'tool-results'), {
                recursive: true,
                force: true,
                preserveTimestamps: true,
              });
            }
          } finally {
            await rm(runWorkspaceRoot, { recursive: true, force: true });
          }
        },
      };
    } catch (err) {
      await rm(runWorkspaceRoot, { recursive: true, force: true });
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

async function findContainingGitRoot(directory: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    return (await runFile('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
      signal,
      timeoutMs: 30_000,
    })).stdout.toString().trim() || undefined;
  } catch {
    return undefined;
  }
}

async function discoverNestedGitRoots(workspaceRoot: string): Promise<string[]> {
  const repositories: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: workspaceRoot, depth: 0 }];
  const skipped = new Set(['.ky-agent', 'assets', 'dist', 'downloads', 'node_modules', 'tmp']);
  while (queue.length > 0 && repositories.length < 2) {
    const current = queue.shift()!;
    if (current.depth > 4) continue;
    const entries = await readdir(current.path, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.name === '.git')) {
      repositories.push(current.path);
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || skipped.has(entry.name)) continue;
      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }
  return repositories;
}

function inferLeadingCommandCwd(command: string): string | undefined {
  const withoutSetPrelude = command.replace(
    /^(?:\s*set\s+(?:-[a-zA-Z]+|-o\s+[a-zA-Z0-9_-]+)\s*(?:;|\n))*/,
    '',
  );
  const match = withoutSetPrelude.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._/@+~-]+))\s*(?:&&|;|\n)/);
  const candidate = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!candidate || candidate.includes('$') || candidate.startsWith('~')) return undefined;
  return candidate;
}

async function resolveWorkspaceDirectory(workspaceRoot: string, inputPath: string): Promise<string> {
  const lexical = isAbsolute(inputPath) ? resolve(inputPath) : resolve(workspaceRoot, inputPath);
  assertInsideWorkspace(workspaceRoot, lexical, 'snapshotCwd');
  const actual = await realpath(lexical);
  assertInsideWorkspace(workspaceRoot, actual, 'snapshotCwd');
  return actual;
}

function assertInsideWorkspace(workspaceRoot: string, candidate: string, label: string): void {
  const rel = relative(workspaceRoot, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${label} escapes workspace`);
}

function workspaceRelativePath(workspaceRoot: string, candidate: string): string {
  return relative(workspaceRoot, candidate).replace(/\\/g, '/') || '.';
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
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 120) || 'snapshot_prepare_failed';
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
