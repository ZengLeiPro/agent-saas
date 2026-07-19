import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_BACKGROUND_SHELL_TIMEOUT_MS = 60 * 60_000;
export const MAX_BACKGROUND_SHELL_TIMEOUT_MS = 24 * 60 * 60_000;
export const MAX_BACKGROUND_SHELL_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_BACKGROUND_SHELL_READ_BYTES = 64 * 1024;

const TASK_ID_PATTERN = /^shell-bg-[A-Za-z0-9-]{8,160}$/;
const TASK_ROOT_SEGMENTS = ['.ky-agent', 'runtime', 'background-shell', 'tasks'] as const;
const TERMINAL_STATUSES = new Set<BackgroundShellStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'lost',
]);

export type BackgroundShellStatus =
  | 'starting'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'lost';

export interface BackgroundShellState {
  version: 1;
  taskId: string;
  commandHash: string;
  status: BackgroundShellStatus;
  requestedAt: string;
  updatedAt: string;
  expiresAt: string;
  timeoutMs: number;
  workerPid?: number;
  childPid?: number;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  stdoutBytes?: number;
  stderrBytes?: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

interface BackgroundShellLaunch {
  command?: string;
  consumedAt?: string;
}

export interface BackgroundShellStartInput {
  workspaceRoot: string;
  taskId: string;
  command: string;
  timeoutMs?: number;
  env: Record<string, string | undefined>;
  spawnWorker?: typeof spawn;
  now?: () => Date;
}

export interface BackgroundShellOutputInput {
  workspaceRoot: string;
  taskId: string;
  stdoutOffset?: number;
  stderrOffset?: number;
  limitBytes?: number;
  waitMs?: number;
}

export interface BackgroundShellOutput {
  taskId: string;
  status: BackgroundShellStatus;
  stdoutPath: string;
  stderrPath: string;
  stdout: string;
  stderr: string;
  stdoutOffset: number;
  stderrOffset: number;
  nextStdoutOffset: number;
  nextStderrOffset: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  expiresAt: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
  protectedUntil?: string;
}

export async function startBackgroundShell(input: BackgroundShellStartInput): Promise<BackgroundShellOutput> {
  const taskDir = backgroundShellTaskDir(input.workspaceRoot, input.taskId);
  const now = input.now?.() ?? new Date();
  const timeoutMs = normalizeBackgroundShellTimeout(input.timeoutMs);
  const commandHash = createHash('sha256').update(input.command).digest('hex');
  await mkdir(backgroundShellTaskRoot(input.workspaceRoot), { recursive: true, mode: 0o700 });
  try {
    await mkdir(taskDir, { mode: 0o700 });
  } catch (err) {
    if (!isErrno(err, 'EEXIST')) throw err;
    const existing = await readBackgroundShellState(taskDir);
    if (existing.commandHash !== commandHash) {
      throw new Error(`background shell task id collision: ${input.taskId}`);
    }
    return await getBackgroundShellOutput({ workspaceRoot: input.workspaceRoot, taskId: input.taskId });
  }

  const requestedAt = now.toISOString();
  const state: BackgroundShellState = {
    version: 1,
    taskId: input.taskId,
    commandHash,
    status: 'starting',
    requestedAt,
    updatedAt: requestedAt,
    expiresAt: new Date(now.getTime() + timeoutMs).toISOString(),
    timeoutMs,
    stdoutBytes: 0,
    stderrBytes: 0,
  };
  await writeBackgroundShellState(taskDir, state);
  await writeJsonAtomic(join(taskDir, 'launch.json'), { command: input.command } satisfies BackgroundShellLaunch, 0o600);
  await writeFile(join(taskDir, 'stdout.log'), '', { encoding: 'utf-8', mode: 0o600 });
  await writeFile(join(taskDir, 'stderr.log'), '', { encoding: 'utf-8', mode: 0o600 });

  const spawnWorker = input.spawnWorker ?? spawn;
  const worker = spawnWorker(resolveTsxBinary(), [resolveWorkerPath(), taskDir, input.taskId], {
    cwd: input.workspaceRoot,
    env: input.env,
    detached: true,
    stdio: 'ignore',
  });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once('spawn', resolve);
      worker.once('error', reject);
    });
  } catch (err) {
    const failedAt = new Date().toISOString();
    await writeJsonAtomic(join(taskDir, 'launch.json'), { consumedAt: failedAt } satisfies BackgroundShellLaunch, 0o600);
    await writeBackgroundShellState(taskDir, {
      ...state,
      status: 'failed',
      completedAt: failedAt,
      updatedAt: failedAt,
      error: `background shell worker failed to start: ${err instanceof Error ? err.message : String(err)}`,
    });
    throw err;
  }
  worker.unref();
  return await getBackgroundShellOutput({ workspaceRoot: input.workspaceRoot, taskId: input.taskId });
}

export async function getBackgroundShellOutput(input: BackgroundShellOutputInput): Promise<BackgroundShellOutput> {
  const taskDir = backgroundShellTaskDir(input.workspaceRoot, input.taskId);
  const waitMs = Math.min(Math.max(Math.floor(input.waitMs ?? 0), 0), 30_000);
  const initialStdoutOffset = normalizeOffset(input.stdoutOffset);
  const initialStderrOffset = normalizeOffset(input.stderrOffset);
  const deadline = Date.now() + waitMs;
  let state = await reconcileBackgroundShellState(taskDir);
  let sizes = await outputSizes(taskDir);
  while (
    waitMs > 0
    && !isBackgroundShellTerminal(state.status)
    && sizes.stdout <= initialStdoutOffset
    && sizes.stderr <= initialStderrOffset
    && Date.now() < deadline
  ) {
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
    state = await reconcileBackgroundShellState(taskDir);
    sizes = await outputSizes(taskDir);
  }
  const limitBytes = Math.min(Math.max(Math.floor(input.limitBytes ?? 20_000), 1), MAX_BACKGROUND_SHELL_READ_BYTES);
  const stdout = await readLogSlice(join(taskDir, 'stdout.log'), initialStdoutOffset, limitBytes);
  const stderr = await readLogSlice(join(taskDir, 'stderr.log'), initialStderrOffset, limitBytes);
  const protectedUntil = await activeBackgroundShellProtectedUntil(input.workspaceRoot);
  return {
    taskId: state.taskId,
    status: state.status,
    stdoutPath: backgroundShellLogPath(state.taskId, 'stdout.log'),
    stderrPath: backgroundShellLogPath(state.taskId, 'stderr.log'),
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutOffset: stdout.offset,
    stderrOffset: stderr.offset,
    nextStdoutOffset: stdout.nextOffset,
    nextStderrOffset: stderr.nextOffset,
    stdoutBytes: sizes.stdout,
    stderrBytes: sizes.stderr,
    stdoutTruncated: state.stdoutTruncated === true,
    stderrTruncated: state.stderrTruncated === true,
    requestedAt: state.requestedAt,
    ...(state.startedAt ? { startedAt: state.startedAt } : {}),
    ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    expiresAt: state.expiresAt,
    ...(state.exitCode !== undefined ? { exitCode: state.exitCode } : {}),
    ...(state.signal !== undefined ? { signal: state.signal } : {}),
    ...(state.error ? { error: state.error } : {}),
    ...(protectedUntil ? { protectedUntil } : {}),
  };
}

export async function killBackgroundShell(workspaceRoot: string, taskId: string): Promise<BackgroundShellOutput> {
  const taskDir = backgroundShellTaskDir(workspaceRoot, taskId);
  let state = await reconcileBackgroundShellState(taskDir);
  if (isBackgroundShellTerminal(state.status)) {
    return await getBackgroundShellOutput({ workspaceRoot, taskId });
  }
  const now = new Date().toISOString();
  state = await writeBackgroundShellState(taskDir, {
    ...state,
    status: 'cancelling',
    updatedAt: now,
  });
  let signalledWorker = signalTaskWorker(state, taskId, 'SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await sleep(100);
    state = await reconcileBackgroundShellState(taskDir);
    if (isBackgroundShellTerminal(state.status)) {
      return await getBackgroundShellOutput({ workspaceRoot, taskId });
    }
    if (!signalledWorker && state.workerPid) {
      state = await writeBackgroundShellState(taskDir, {
        ...state,
        status: 'cancelling',
        updatedAt: new Date().toISOString(),
      });
      signalledWorker = signalTaskWorker(state, taskId, 'SIGTERM');
    }
  }
  if (state.childPid) signalTaskChild(state.childPid, taskId, 'SIGKILL');
  signalTaskWorker(state, taskId, 'SIGKILL');
  const cancelledAt = new Date().toISOString();
  await writeBackgroundShellState(taskDir, {
    ...state,
    status: 'cancelled',
    completedAt: cancelledAt,
    updatedAt: cancelledAt,
    error: 'background shell cancelled',
  });
  return await getBackgroundShellOutput({ workspaceRoot, taskId });
}

export async function reconcileBackgroundShells(workspaceRoot: string): Promise<{ protectedUntil?: string; activeTaskIds: string[] }> {
  const root = backgroundShellTaskRoot(workspaceRoot);
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && TASK_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return { activeTaskIds: [] };
    throw err;
  }
  const active: BackgroundShellState[] = [];
  for (const taskId of entries) {
    try {
      const state = await reconcileBackgroundShellState(join(root, taskId));
      if (!isBackgroundShellTerminal(state.status)) active.push(state);
    } catch {
      // 单个损坏任务记录不能阻断同 workspace 其他任务的生命周期保护。
    }
  }
  const protectedUntil = active
    // timeout 时 worker 先 TERM、5 秒后才 KILL；生命周期额外留 10 秒收尾窗口。
    .map((state) => new Date(Date.parse(state.expiresAt) + 10_000).toISOString())
    .sort()
    .at(-1);
  return {
    ...(protectedUntil ? { protectedUntil } : {}),
    activeTaskIds: active.map((state) => state.taskId),
  };
}

export async function activeBackgroundShellProtectedUntil(workspaceRoot: string): Promise<string | undefined> {
  return (await reconcileBackgroundShells(workspaceRoot)).protectedUntil;
}

export async function readBackgroundShellState(taskDir: string): Promise<BackgroundShellState> {
  const parsed = JSON.parse(await readFile(join(taskDir, 'state.json'), 'utf-8')) as Partial<BackgroundShellState>;
  if (
    parsed.version !== 1
    || typeof parsed.taskId !== 'string'
    || !TASK_ID_PATTERN.test(parsed.taskId)
    || typeof parsed.commandHash !== 'string'
    || typeof parsed.status !== 'string'
    || typeof parsed.requestedAt !== 'string'
    || typeof parsed.updatedAt !== 'string'
    || typeof parsed.expiresAt !== 'string'
    || typeof parsed.timeoutMs !== 'number'
  ) {
    throw new Error('background shell state is invalid');
  }
  return parsed as BackgroundShellState;
}

export async function writeBackgroundShellState(taskDir: string, state: BackgroundShellState): Promise<BackgroundShellState> {
  await writeJsonAtomic(join(taskDir, 'state.json'), state, 0o600);
  return state;
}

export async function consumeBackgroundShellLaunch(taskDir: string): Promise<string> {
  const path = join(taskDir, 'launch.json');
  const launch = JSON.parse(await readFile(path, 'utf-8')) as BackgroundShellLaunch;
  if (typeof launch.command !== 'string' || !launch.command) throw new Error('background shell launch command missing');
  await writeJsonAtomic(path, { consumedAt: new Date().toISOString() } satisfies BackgroundShellLaunch, 0o600);
  return launch.command;
}

export function backgroundShellTaskRoot(workspaceRoot: string): string {
  return join(workspaceRoot, ...TASK_ROOT_SEGMENTS);
}

export function backgroundShellTaskDir(workspaceRoot: string, taskId: string): string {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error('后台 Shell task_id 非法。');
  return join(backgroundShellTaskRoot(workspaceRoot), taskId);
}

function backgroundShellLogPath(taskId: string, fileName: 'stdout.log' | 'stderr.log'): string {
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error('后台 Shell task_id 非法。');
  return [...TASK_ROOT_SEGMENTS, taskId, fileName].join('/');
}

export function isBackgroundShellTerminal(status: BackgroundShellStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function normalizeBackgroundShellTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_BACKGROUND_SHELL_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1_000 || timeout > MAX_BACKGROUND_SHELL_TIMEOUT_MS) {
    throw new Error(`后台 Shell timeoutMs 必须在 1000-${MAX_BACKGROUND_SHELL_TIMEOUT_MS} 之间。`);
  }
  return Math.floor(timeout);
}

async function reconcileBackgroundShellState(taskDir: string): Promise<BackgroundShellState> {
  const state = await readBackgroundShellState(taskDir);
  if (isBackgroundShellTerminal(state.status)) return state;
  const taskId = state.taskId;
  const nowMs = Date.now();
  const expiresAtMs = Date.parse(state.expiresAt);
  if (expiresAtMs <= nowMs && state.workerPid && isTaskProcessAlive(state.workerPid, taskId)) {
    // worker 自己负责把 timeout 记为 timed_out，并给子进程 5 秒 TERM/KILL 窗口。
    if (nowMs <= expiresAtMs + 7_000) return state;
    if (state.childPid) signalTaskChild(state.childPid, taskId, 'SIGKILL');
    signalTaskWorker(state, taskId, 'SIGKILL');
    const completedAt = new Date().toISOString();
    return await writeBackgroundShellState(taskDir, {
      ...state,
      status: 'timed_out',
      completedAt,
      updatedAt: completedAt,
      error: `background shell timed out after ${state.timeoutMs}ms`,
    });
  }
  if (state.workerPid && isTaskProcessAlive(state.workerPid, taskId)) return state;
  const updatedAtMs = Date.parse(state.updatedAt);
  if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < 2_000) return state;
  if (state.childPid) signalTaskChild(state.childPid, taskId, 'SIGKILL');
  const now = new Date().toISOString();
  return await writeBackgroundShellState(taskDir, {
    ...state,
    status: 'lost',
    completedAt: now,
    updatedAt: now,
    error: 'background shell worker is no longer running',
  });
}

function isTaskProcessAlive(pid: number, taskId: string): boolean {
  if (!isProcessAlive(pid)) return false;
  if (process.platform !== 'linux') return true;
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`).toString('utf-8');
    return cmdline.includes(taskId) || cmdline.includes('backgroundShellWorker');
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalTaskWorker(state: BackgroundShellState, taskId: string, signal: NodeJS.Signals): boolean {
  if (!state.workerPid || !isTaskProcessAlive(state.workerPid, taskId)) return false;
  try {
    process.kill(state.workerPid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalTaskChild(pid: number, taskId: string, signal: NodeJS.Signals): boolean {
  if (!isTaskChildAlive(pid, taskId)) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isTaskChildAlive(pid: number, taskId: string): boolean {
  if (!isProcessAlive(pid)) return false;
  if (process.platform !== 'linux') return true;
  try {
    const environ = readFileSync(`/proc/${pid}/environ`).toString('utf-8');
    return environ.split('\0').includes(`KY_BACKGROUND_SHELL_TASK_ID=${taskId}`);
  } catch {
    return false;
  }
}

async function outputSizes(taskDir: string): Promise<{ stdout: number; stderr: number }> {
  return {
    stdout: await fileSize(join(taskDir, 'stdout.log')),
    stderr: await fileSize(join(taskDir, 'stderr.log')),
  };
}

async function fileSize(path: string): Promise<number> {
  try { return (await stat(path)).size; } catch (err) { if (isErrno(err, 'ENOENT')) return 0; throw err; }
}

async function readLogSlice(path: string, requestedOffset: number, limitBytes: number): Promise<{ text: string; offset: number; nextOffset: number }> {
  const size = await fileSize(path);
  const offset = Math.min(requestedOffset, size);
  if (offset >= size) return { text: '', offset, nextOffset: offset };
  const length = Math.min(limitBytes, size - offset);
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { text: buffer.toString('utf-8', 0, bytesRead), offset, nextOffset: offset + bytesRead };
  } finally {
    await handle.close();
  }
}

async function writeJsonAtomic(path: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode });
  await rename(tempPath, path);
}

function resolveWorkerPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'backgroundShellWorker.ts');
}

function resolveTsxBinary(): string {
  const configured = process.env.ACS_TSX_BIN?.trim();
  if (configured) return configured;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, '..', 'node_modules', '.bin', 'tsx'),
    join(moduleDir, '..', '..', 'node_modules', '.bin', 'tsx'),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function normalizeOffset(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) return 0;
  return Math.floor(value);
}

function isErrno(err: unknown, code: string): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === code;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
