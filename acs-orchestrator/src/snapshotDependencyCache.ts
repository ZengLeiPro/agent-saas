import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

const DEPENDENCY_PREPARE_TIMEOUT_MS = 4 * 60_000;
const dependencyPrepares = new Map<string, Promise<void>>();

export interface SnapshotDependencyResult {
  prepared: boolean;
  cacheHit?: boolean;
  cacheKey?: string;
}

export async function ensureSnapshotNodeDependencies(input: {
  runRoot: string;
  command: string;
  packageCacheRoot: string;
  env: Record<string, string>;
  signal: AbortSignal;
  progress?: (message: string) => void;
}): Promise<SnapshotDependencyResult> {
  const manager = await detectPackageManager(input.runRoot);
  if (
    !manager
    || commandInstallsDependencies(input.command, manager)
    || !commandNeedsNodeDependencies(input.command)
  ) return { prepared: false };

  const cacheKey = await dependencyContractKey(input.runRoot, manager, input.env, input.signal);
  const preparedRoot = join(input.packageCacheRoot, 'prepared-node-modules', cacheKey);
  if (await dependencyCacheReady(preparedRoot)) {
    input.progress?.('正在从容器临时盘复用已准备的依赖树');
    await materializeDependencyCache(preparedRoot, input.runRoot, input.signal);
    return { prepared: true, cacheHit: true, cacheKey };
  }

  const existing = dependencyPrepares.get(preparedRoot);
  if (existing) {
    input.progress?.('正在等待同一份依赖缓存准备完成');
    await existing;
    await materializeDependencyCache(preparedRoot, input.runRoot, input.signal);
    return { prepared: true, cacheHit: true, cacheKey };
  }

  const prepare = (async () => {
    input.progress?.(`正在容器临时盘准备 ${manager} 依赖缓存`);
    await installDependencies(manager, input.runRoot, input.env, input.signal);
    await publishDependencyCache(input.runRoot, preparedRoot, input.signal);
  })();
  dependencyPrepares.set(preparedRoot, prepare);
  try {
    await prepare;
  } finally {
    if (dependencyPrepares.get(preparedRoot) === prepare) dependencyPrepares.delete(preparedRoot);
  }
  return { prepared: true, cacheHit: false, cacheKey };
}

type PackageManager = 'pnpm' | 'npm';

export function commandNeedsNodeDependencies(command: string): boolean {
  const directTool = /(?:^|[;&|()]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:\.\/node_modules\/\.bin\/)?(?:npx|tsx|ts-node|tsc|vitest|vite|jest|eslint|prettier|next|nuxt|turbo|webpack|rollup|esbuild)(?:\s|$)/;
  if (directTool.test(command)) return true;
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const match = segment.match(/(?:^|\s)(?:corepack\s+)?(pnpm|npm)\s+(.+)$/);
    if (!match) continue;
    const manager = match[1] as PackageManager;
    const tokens = shellWords(match[2] ?? '');
    const subcommand = packageManagerSubcommand(tokens, manager);
    if (!subcommand) continue;
    if (manager === 'npm') {
      if (['run', 'run-script', 'test', 'start', 'restart', 'stop', 'exec'].includes(subcommand)) return true;
      continue;
    }
    if (!['add', 'audit', 'config', 'create', 'fetch', 'help', 'i', 'import', 'info', 'init', 'install', 'list', 'outdated', 'patch', 'publish', 'remove', 'root', 'setup', 'store', 'update', 'view', 'why'].includes(subcommand)) return true;
  }
  return false;
}

function shellWords(value: string): string[] {
  return [...value.matchAll(/"[^"]*"|'[^']*'|\S+/g)].map((match) => match[0]!.replace(/^(?:"|')|(?:"|')$/g, ''));
}

function packageManagerSubcommand(tokens: string[], manager: PackageManager): string | undefined {
  const optionsWithValue = manager === 'pnpm'
    ? new Set(['--dir', '--filter', '--global-dir', '--store-dir', '--workspace-root', '-C', '-F'])
    : new Set(['--prefix', '--workspace', '-w']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (optionsWithValue.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return undefined;
}

async function detectPackageManager(runRoot: string): Promise<PackageManager | undefined> {
  if (!(await pathExists(join(runRoot, 'package.json')))) return undefined;
  if (await pathExists(join(runRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await pathExists(join(runRoot, 'package-lock.json'))) return 'npm';
  return undefined;
}

async function installDependencies(
  manager: PackageManager,
  runRoot: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<void> {
  const args = manager === 'pnpm'
    ? ['install', '--frozen-lockfile', '--prefer-offline', '--reporter=append-only']
    : ['ci', '--prefer-offline', '--no-audit', '--no-fund'];
  await runFile(manager, args, {
    cwd: runRoot,
    env: { ...env, NODE_ENV: 'development' },
    signal,
    timeoutMs: DEPENDENCY_PREPARE_TIMEOUT_MS,
  });
}

async function dependencyContractKey(
  runRoot: string,
  manager: PackageManager,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  hash.update(`${manager}\0${process.version}\0${process.platform}\0${process.arch}\0${env.ACS_SANDBOX_IMAGE ?? ''}\0`);
  const listed = await runFile('git', [
    '-C', runRoot,
    'ls-files', '-co', '--exclude-standard', '-z', '--',
    ':(glob)**/package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'pnpm-workspace.yaml',
    '.npmrc',
    ':(glob)patches/**',
  ], { signal, timeoutMs: 30_000, encoding: 'buffer' });
  const paths = [...new Set(listed.stdout.toString().split('\0').filter(Boolean))].sort();
  for (const path of paths) {
    const fullPath = safeChildPath(runRoot, path);
    if (!(await pathExists(fullPath))) continue;
    hash.update(path).update('\0').update(await readFile(fullPath)).update('\0');
  }
  return hash.digest('hex');
}

async function publishDependencyCache(runRoot: string, preparedRoot: string, signal: AbortSignal): Promise<void> {
  const nodeModulesRoots = await findNodeModulesRoots(runRoot);
  if (nodeModulesRoots.length === 0) throw new Error('dependency install completed without node_modules');
  await mkdir(dirname(preparedRoot), { recursive: true });
  const temporary = `${preparedRoot}.tmp-${process.pid}-${Date.now()}`;
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    for (const relativePath of nodeModulesRoots) {
      const source = safeChildPath(runRoot, relativePath);
      const target = safeChildPath(temporary, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await hardlinkTree(source, target, signal);
    }
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify({ version: 1, nodeModulesRoots }), 'utf8');
    try {
      await rename(temporary, preparedRoot);
    } catch (err) {
      if (!(await dependencyCacheReady(preparedRoot))) throw err;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function materializeDependencyCache(
  preparedRoot: string,
  runRoot: string,
  signal: AbortSignal,
): Promise<void> {
  const manifest = JSON.parse(await readFile(join(preparedRoot, 'manifest.json'), 'utf8')) as {
    version?: unknown;
    nodeModulesRoots?: unknown;
  };
  if (manifest.version !== 1 || !Array.isArray(manifest.nodeModulesRoots)) {
    throw new Error('snapshot dependency cache manifest is invalid');
  }
  for (const value of manifest.nodeModulesRoots) {
    if (typeof value !== 'string') throw new Error('snapshot dependency cache path is invalid');
    const source = safeChildPath(preparedRoot, value);
    const target = safeChildPath(runRoot, value);
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await hardlinkTree(source, target, signal);
  }
}

async function findNodeModulesRoots(runRoot: string): Promise<string[]> {
  const found: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: runRoot, depth: 0 }];
  const skipped = new Set(['.git', '.next', '.turbo', 'coverage', 'dist', 'downloads', 'tmp']);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > 8) continue;
    for (const entry of await readdir(current.path, { withFileTypes: true })) {
      if (entry.name === 'node_modules') {
        found.push(relative(runRoot, join(current.path, entry.name)));
        continue;
      }
      if (!entry.isDirectory() || skipped.has(entry.name)) continue;
      queue.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }
  return found.sort();
}

async function hardlinkTree(source: string, target: string, signal: AbortSignal): Promise<void> {
  await runFile('cp', ['-a', '-l', source, target], { signal, timeoutMs: DEPENDENCY_PREPARE_TIMEOUT_MS });
}

function commandInstallsDependencies(command: string, packageManager: PackageManager): boolean {
  return new RegExp(`(?:^|[;&|]\\s*)(?:corepack\\s+)?${packageManager}\\s+(?:i|install|ci)(?:\\s|$)`).test(command);
}

function safeChildPath(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\0')) throw new Error('invalid dependency cache path');
  const target = resolve(root, relativePath);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (target !== root && !target.startsWith(prefix)) throw new Error(`dependency cache path escapes root: ${relativePath}`);
  return target;
}

async function dependencyCacheReady(preparedRoot: string): Promise<boolean> {
  return await pathExists(join(preparedRoot, 'manifest.json'));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
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
