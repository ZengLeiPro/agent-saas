import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ServerLocalExecutionProvider, type WorkspaceRef } from 'server/agent/toolRuntime.js';
import type { ToolInvocationResponse, ToolInvocationStreamChunk } from 'server/runtime/handProtocol.js';

import type { SandboxRunnerFinalOutput, SandboxRunnerInput, SandboxRunnerOutput } from './protocol.js';
import {
  getBackgroundShellOutput,
  killBackgroundShell,
  reconcileBackgroundShells,
  startBackgroundShell,
} from './backgroundShell.js';

const PYTHON_RUNTIME_CONTRACT_VERSION = 1;
const DEFAULT_PIP_INSTALL_TIMEOUT_MS = 240_000;
const DEFAULT_PYTHON_WHEELHOUSE = '/opt/ky-agent/python-wheels';
const DEFAULT_MAX_VENV_ARCHIVES = 2;
const DEFAULT_RUNTIME_PATH_SEGMENTS = [
  '/home/agent/.npm-global/bin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/usr/sbin',
  '/bin',
  '/sbin',
];

export interface PythonEnvInfo {
  venvPath: string;
  pythonPath: string;
  pipCacheDir: string;
  manifestPath: string;
  rebuilt: boolean;
  rebuildReasons: string[];
}

interface PythonRuntimeManifest {
  contractVersion: number;
  pythonMajorMinor: string;
  baseRequirementsHash: string;
  imageRef?: string;
  createdAt: string;
}

export interface EnsurePythonEnvOptions {
  baseRequirementsPath?: string;
  imageRef?: string;
  maxVenvArchives?: number;
  skipBaseInstall?: boolean;
  installTimeoutMs?: number;
  now?: () => Date;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

function writeJsonLine(value: SandboxRunnerOutput | SandboxRunnerFinalOutput): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const input = JSON.parse(raw || '{}') as SandboxRunnerInput;
  const workspaceRoot = input.workspace.root || process.env.ACS_WORKSPACE_PATH || '/workspace';
  ensurePythonEnv(workspaceRoot);
  const workspace: WorkspaceRef = {
    id: input.workspace.id,
    root: workspaceRoot,
    userId: input.workspace.userId,
    username: input.workspace.username,
    sessionId: input.workspace.sessionId,
    executionTarget: 'server-local',
  };
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  process.once('SIGHUP', abort);

  // 07-05：从 wire 传下来的 input.env（允许列表内的 AZEROTH_TOKEN 等）合并进
  // provider spawn 的子进程 env。ServerLocalExecutionProvider 的 envBuilder 在
  // 未注入时 fallback process.env；这里显式装配 "pod process.env + input.env"，
  // 保持 pod 自身 env（PATH/PYTHONPATH 等）+ 允许 wire 层追加凭据。
  const wireEnvOverride = input.env ?? {};
  const provider = Object.keys(wireEnvOverride).length > 0
    ? new ServerLocalExecutionProvider({
        envBuilder: (_workspace) => ({
          ...(process.env as Record<string, string | undefined>),
          ...wireEnvOverride,
        }) as Record<string, string>,
      })
    : new ServerLocalExecutionProvider();
  const localToolName = toolNameForLocalProvider(input.toolName);
  const backgroundResponse = await executeBackgroundShellTool({
    toolName: localToolName,
    input: input.input,
    workspaceRoot,
    env: {
      ...(process.env as Record<string, string | undefined>),
      ...wireEnvOverride,
    },
  });
  if (backgroundResponse) {
    writeJsonLine({ kind: 'final', response: backgroundResponse });
    return;
  }
  const request = {
    toolName: localToolName,
    input: input.input,
    context: {
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      workspace,
      signal: abortController.signal,
    },
  };

  if (input.stream && provider.executeStream) {
    for await (const chunk of provider.executeStream(request)) {
      writeJsonLine({ kind: 'chunk', chunk: chunk as ToolInvocationStreamChunk });
    }
    return;
  }

  const response = await provider.execute(request);
  writeJsonLine({ kind: 'final', response });
}

async function executeBackgroundShellTool(input: {
  toolName: string;
  input: unknown;
  workspaceRoot: string;
  env: Record<string, string | undefined>;
}): Promise<ToolInvocationResponse | null> {
  const args = input.input && typeof input.input === 'object'
    ? input.input as Record<string, unknown>
    : {};
  try {
    if (input.toolName === 'Shell' && args.mode === 'background') {
      if (typeof args.taskId !== 'string' || typeof args.command !== 'string' || !args.command) {
        return { status: 'error', error: '后台 Shell 需要 taskId 和非空 command。' };
      }
      const output = await startBackgroundShell({
        workspaceRoot: input.workspaceRoot,
        taskId: args.taskId,
        command: args.command,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        env: input.env,
      });
      return backgroundShellResponse(output);
    }
    if (input.toolName === 'BashOutput') {
      if (typeof args.task_id !== 'string') return { status: 'error', error: 'BashOutput 需要 task_id。' };
      const output = await getBackgroundShellOutput({
        workspaceRoot: input.workspaceRoot,
        taskId: args.task_id,
        stdoutOffset: typeof args.stdout_offset === 'number' ? args.stdout_offset : undefined,
        stderrOffset: typeof args.stderr_offset === 'number' ? args.stderr_offset : undefined,
        limitBytes: typeof args.limit_bytes === 'number' ? args.limit_bytes : undefined,
        waitMs: typeof args.wait_ms === 'number' ? args.wait_ms : undefined,
      });
      return backgroundShellResponse(output);
    }
    if (input.toolName === 'KillBash') {
      if (typeof args.task_id !== 'string') return { status: 'error', error: 'KillBash 需要 task_id。' };
      return backgroundShellResponse(await killBackgroundShell(input.workspaceRoot, args.task_id));
    }
    if (input.toolName === '__BackgroundShellReconcile') {
      const result = await reconcileBackgroundShells(input.workspaceRoot);
      return {
        status: 'success',
        content: JSON.stringify(result),
        metadata: { backgroundShell: result },
      };
    }
    return null;
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

function backgroundShellResponse(output: Awaited<ReturnType<typeof getBackgroundShellOutput>>): ToolInvocationResponse {
  return {
    status: 'success',
    content: JSON.stringify(output),
    metadata: {
      backgroundShell: {
        taskId: output.taskId,
        status: output.status,
        ...(output.protectedUntil ? { protectedUntil: output.protectedUntil } : {}),
      },
    },
  };
}

export function toolNameForLocalProvider(toolName: string): string {
  switch (toolName) {
    case 'read_file':
      return 'Read';
    case 'write_file':
      return 'Write';
    case 'list_files':
      return 'List';
    case 'run_shell':
      return 'Shell';
    default:
      return toolName;
  }
}

export function ensurePythonEnv(workspaceRoot: string, options: EnsurePythonEnvOptions = {}): PythonEnvInfo {
  const venvPath = join(workspaceRoot, '.ky-agent', 'runtime', 'venv');
  const pythonPath = join(venvPath, 'bin', 'python3');
  const pipCacheDir = join(workspaceRoot, '.ky-agent', 'runtime', 'cache', 'pip');
  const manifestPath = join(venvPath, '.ky-runtime.json');
  const baseRequirementsPath = options.baseRequirementsPath ?? resolveBaseRequirementsPath();
  const baseRequirementsHash = hashFileIfExists(baseRequirementsPath);
  const imageRef = options.imageRef ?? process.env.ACS_SANDBOX_IMAGE;
  const desiredPythonMajorMinor = currentSystemPythonMajorMinor();
  const rebuildReasons = venvRebuildReasons({
    venvPath,
    pythonPath,
    manifestPath,
    desired: {
      contractVersion: PYTHON_RUNTIME_CONTRACT_VERSION,
      pythonMajorMinor: desiredPythonMajorMinor,
      baseRequirementsHash,
      ...(imageRef ? { imageRef } : {}),
    },
  });
  let rebuilt = false;

  mkdirSync(dirname(venvPath), { recursive: true });
  mkdirSync(pipCacheDir, { recursive: true });
  if (rebuildReasons.length > 0) {
    archiveBrokenVenv(workspaceRoot, venvPath, options.maxVenvArchives ?? readMaxVenvArchives());
    execFileSync('python3', ['-m', 'venv', venvPath], { timeout: 30_000, stdio: 'pipe' });
    rebuilt = true;
    configurePythonEnv(venvPath, pipCacheDir);
    if (!options.skipBaseInstall && process.env.ACS_PYTHON_ENV_SKIP_BASE_INSTALL !== '1') {
      installBaseRequirements(pythonPath, baseRequirementsPath, options.installTimeoutMs ?? readInstallTimeoutMs());
    }
    writeRuntimeManifest(manifestPath, {
      contractVersion: PYTHON_RUNTIME_CONTRACT_VERSION,
      pythonMajorMinor: desiredPythonMajorMinor,
      baseRequirementsHash,
      ...(imageRef ? { imageRef } : {}),
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
    });
  }
  configurePythonEnv(venvPath, pipCacheDir);
  return { venvPath, pythonPath, pipCacheDir, manifestPath, rebuilt, rebuildReasons };
}

export function venvRebuildReasons(input: {
  venvPath: string;
  pythonPath: string;
  manifestPath: string;
  desired: Omit<PythonRuntimeManifest, 'createdAt'>;
}): string[] {
  const reasons: string[] = [];
  if (!isUsablePython(input.pythonPath)) reasons.push('python-unusable');
  if (!isIsolatedVenv(input.venvPath)) reasons.push('venv-not-isolated');
  const manifest = readRuntimeManifest(input.manifestPath);
  if (!manifest) {
    reasons.push('manifest-missing-or-invalid');
    return reasons;
  }
  if (manifest.contractVersion !== input.desired.contractVersion) reasons.push('contract-version-changed');
  if (manifest.pythonMajorMinor !== input.desired.pythonMajorMinor) reasons.push('python-version-changed');
  if (manifest.baseRequirementsHash !== input.desired.baseRequirementsHash) reasons.push('base-requirements-changed');
  if (input.desired.imageRef && manifest.imageRef !== input.desired.imageRef) reasons.push('image-ref-changed');
  return reasons;
}

function configurePythonEnv(venvPath: string, pipCacheDir: string): void {
  process.env.VIRTUAL_ENV = venvPath;
  process.env.PATH = buildRuntimePath(venvPath, process.env.PATH);
  process.env.PIP_CACHE_DIR = pipCacheDir;
  process.env.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  process.env.PIP_REQUIRE_VIRTUALENV = '1';
}

export function buildRuntimePath(venvPath: string, currentPath = ''): string {
  const segments = [
    join(venvPath, 'bin'),
    ...DEFAULT_RUNTIME_PATH_SEGMENTS,
    ...currentPath.split(':'),
  ];
  return [...new Set(segments.map((segment) => segment.trim()).filter(Boolean))].join(':');
}

function isUsablePython(pythonPath: string): boolean {
  if (!existsSync(pythonPath)) return false;
  try {
    execFileSync(pythonPath, ['--version'], { timeout: 5_000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function isIsolatedVenv(venvPath: string): boolean {
  const cfgPath = join(venvPath, 'pyvenv.cfg');
  if (!existsSync(cfgPath)) return false;
  try {
    const cfg = readFileSync(cfgPath, 'utf-8');
    return /^\s*include-system-site-packages\s*=\s*false\s*$/mi.test(cfg);
  } catch {
    return false;
  }
}

function currentSystemPythonMajorMinor(): string {
  return execFileSync('python3', ['-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
    timeout: 5_000,
    stdio: 'pipe',
  }).toString('utf-8').trim();
}

function readRuntimeManifest(path: string): PythonRuntimeManifest | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PythonRuntimeManifest>;
    if (
      typeof parsed.contractVersion !== 'number'
      || typeof parsed.pythonMajorMinor !== 'string'
      || typeof parsed.baseRequirementsHash !== 'string'
      || typeof parsed.createdAt !== 'string'
    ) {
      return null;
    }
    return {
      contractVersion: parsed.contractVersion,
      pythonMajorMinor: parsed.pythonMajorMinor,
      baseRequirementsHash: parsed.baseRequirementsHash,
      ...(typeof parsed.imageRef === 'string' ? { imageRef: parsed.imageRef } : {}),
      createdAt: parsed.createdAt,
    };
  } catch {
    return null;
  }
}

function writeRuntimeManifest(path: string, manifest: PythonRuntimeManifest): void {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

function resolveBaseRequirementsPath(): string {
  if (process.env.ACS_BASE_REQUIREMENTS_PATH?.trim()) return process.env.ACS_BASE_REQUIREMENTS_PATH.trim();
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'requirements', 'base.txt');
}

function hashFileIfExists(path: string): string {
  if (!existsSync(path)) return 'missing';
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function installBaseRequirements(pythonPath: string, requirementsPath: string, timeoutMs: number): void {
  if (!existsSync(requirementsPath)) {
    throw new Error(`Base Python requirements file not found: ${requirementsPath}`);
  }
  const content = readFileSync(requirementsPath, 'utf-8');
  const hasRequirements = content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith('#');
  });
  if (!hasRequirements) return;
  const wheelhousePath = resolvePythonWheelhousePath();
  const localWheelhousePath = wheelhousePath && existsSync(wheelhousePath) ? wheelhousePath : undefined;
  execFileSync(pythonPath, pipInstallArgs(requirementsPath, localWheelhousePath), {
    timeout: timeoutMs,
    stdio: 'pipe',
    env: process.env,
  });
}

export function pipInstallArgs(requirementsPath: string, wheelhousePath?: string): string[] {
  return [
    '-m',
    'pip',
    'install',
    ...(wheelhousePath ? ['--no-index', `--find-links=${wheelhousePath}`] : []),
    '-r',
    requirementsPath,
  ];
}

function resolvePythonWheelhousePath(): string | undefined {
  const raw = process.env.ACS_PYTHON_WHEELHOUSE?.trim();
  if (raw === '0' || raw === 'false' || raw === 'none') return undefined;
  return raw || DEFAULT_PYTHON_WHEELHOUSE;
}

function readInstallTimeoutMs(): number {
  const raw = process.env.ACS_PIP_INSTALL_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_PIP_INSTALL_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PIP_INSTALL_TIMEOUT_MS;
}

function readMaxVenvArchives(): number {
  const raw = process.env.ACS_MAX_VENV_ARCHIVES?.trim();
  if (!raw) return DEFAULT_MAX_VENV_ARCHIVES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_VENV_ARCHIVES;
}

function archiveBrokenVenv(workspaceRoot: string, venvPath: string, maxArchives: number): void {
  if (!existsSync(venvPath)) return;
  const archiveRoot = join(workspaceRoot, '.ky-agent', 'runtime', 'venv-archive');
  mkdirSync(archiveRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    renameSync(venvPath, join(archiveRoot, `.venv-${stamp}`));
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === 'ENOENT') return;
    throw err;
  }
  try {
    pruneVenvArchive(archiveRoot, maxArchives);
  } catch {
    // Archive cleanup is best-effort; venv rebuild must still proceed.
  }
}

export function pruneVenvArchive(archiveRoot: string, maxArchives = DEFAULT_MAX_VENV_ARCHIVES): string[] {
  if (!existsSync(archiveRoot)) return [];
  const kept = Math.max(0, maxArchives);
  const archives = readdirSync(archiveRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('.venv-'))
    .map((entry) => {
      const path = join(archiveRoot, entry.name);
      return {
        name: entry.name,
        path,
        mtimeMs: statSync(path).mtimeMs,
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  const deleted: string[] = [];
  for (const archive of archives.slice(kept)) {
    rmSync(archive.path, { recursive: true, force: true });
    deleted.push(archive.path);
  }
  return deleted;
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
}

if (isDirectRun()) {
  main().catch((err) => {
    writeJsonLine({
      kind: 'final',
      response: {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      },
    });
    process.exitCode = 1;
  });
}
