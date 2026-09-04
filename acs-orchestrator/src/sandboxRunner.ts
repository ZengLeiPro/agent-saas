import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ServerLocalExecutionProvider, type WorkspaceRef } from 'server/agent/toolRuntime.js';
import type { ToolInvocationResponse, ToolInvocationStreamChunk } from 'server/runtime/handProtocol.js';
import { runWithInvocationCorrelation } from 'server/runtime/invocationCorrelation.js';

import type { SandboxRunnerFinalOutput, SandboxRunnerInput, SandboxRunnerOutput } from './protocol.js';
import { runSandboxRunnerDaemon } from './sandboxRunnerDaemon.js';
import {
  snapshotAutoRoutingReason,
  type SnapshotAutoRoutingReason,
} from './snapshotAutoRouting.js';
import {
  snapshotWorkspaceRoutingReason,
  type SnapshotWorkspaceRoutingReason,
} from './shellExecutionRouting.js';
import { prepareSnapshotExecution, resolveExecutionCwd, type SnapshotExecutionMetadata } from './snapshotExecution.js';
import {
  executeSnapshotValidationChain,
  planSnapshotValidationChain,
} from './snapshotValidationChain.js';
import {
  getBackgroundShellOutput,
  killBackgroundShell,
  reconcileBackgroundShells,
  startBackgroundShell,
  terminateBackgroundShellsFailClosed,
  type BackgroundShellOutput,
} from './backgroundShell.js';

const PYTHON_RUNTIME_CONTRACT_VERSION = 2;
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
  /** rebuild 锁等待上限（默认 300s）；测试注入用。 */
  rebuildLockWaitMs?: number;
  /** rebuild 锁 stale 抢占阈值（默认 900s）；持有者进程被杀时防死锁。 */
  rebuildLockStaleMs?: number;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

function writeJsonLine(value: SandboxRunnerOutput | SandboxRunnerFinalOutput): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function executeSandboxRunnerInput(
  input: SandboxRunnerInput,
  signal: AbortSignal,
  emit: (output: SandboxRunnerOutput | SandboxRunnerFinalOutput) => void,
  options: { skipPythonEnv?: boolean } = {},
): Promise<void> {
  return await runWithInvocationCorrelation(input.correlation, () =>
    executeSandboxRunnerInputInternal(input, signal, emit, options));
}

async function executeSandboxRunnerInputInternal(
  input: SandboxRunnerInput,
  signal: AbortSignal,
  emit: (output: SandboxRunnerOutput | SandboxRunnerFinalOutput) => void,
  options: { skipPythonEnv?: boolean } = {},
): Promise<void> {
  const workspaceRoot = input.workspace.root || process.env.ACS_WORKSPACE_PATH || '/workspace';
  if (input.toolName === '__FeishuCli') {
    emit({ kind: 'final', response: executeFeishuCli(input.input, workspaceRoot) });
    return;
  }
  if (!options.skipPythonEnv) ensurePythonEnv(workspaceRoot);
  // 07-05：从 wire 传下来的 input.env（允许列表内的 AZEROTH_TOKEN 等）合并进
  // provider spawn 的子进程 env。ServerLocalExecutionProvider 的 envBuilder 在
  // 未注入时 fallback process.env；这里显式装配 "pod process.env + input.env"，
  // 保持 pod 自身 env（PATH/PYTHONPATH 等）+ 允许 wire 层追加凭据。
  const wireEnvOverride = input.env ?? {};
  const localToolName = toolNameForLocalProvider(input.toolName);
  const toolInput = input.input && typeof input.input === 'object' && !Array.isArray(input.input)
    ? input.input as Record<string, unknown>
    : {};
  const requestedCwd = localToolName === 'Shell' && typeof toolInput.cwd === 'string'
    ? toolInput.cwd
    : undefined;
  const effectiveToolInput = localToolName === 'Shell' && typeof toolInput.command === 'string'
    ? { ...toolInput, command: normalizeShellCommandForCwd(toolInput.command, requestedCwd) }
    : input.input;
  const baseEnv = {
    ...(process.env as Record<string, string | undefined>),
    ...wireEnvOverride,
  } as Record<string, string>;
  const backgroundResponse = await executeBackgroundShellTool({
    toolName: localToolName,
    input: effectiveToolInput,
    workspaceRoot,
    env: baseEnv,
  });
  if (backgroundResponse) {
    emit({ kind: 'final', response: backgroundResponse });
    return;
  }
  const effectiveCommand = typeof effectiveToolInput === 'object'
    && effectiveToolInput
    && 'command' in effectiveToolInput
    ? String(effectiveToolInput.command)
    : '';
  const workspaceRoutingReason = localToolName === 'Shell' && toolInput.execution === 'snapshot'
    ? snapshotWorkspaceRoutingReason(effectiveCommand)
    : undefined;
  const autoSnapshotReason = localToolName === 'Shell' && !workspaceRoutingReason
    ? snapshotAutoRoutingReason(effectiveCommand, toolInput.execution)
    : undefined;
  const shouldUseSnapshot = localToolName === 'Shell'
    && (toolInput.execution === 'snapshot' || Boolean(autoSnapshotReason))
    && !workspaceRoutingReason;
  const validationPlan = shouldUseSnapshot
    ? planSnapshotValidationChain(effectiveCommand)
    : undefined;
  if (validationPlan) {
    const response = await executeSnapshotValidationChain({
      plan: validationPlan,
      workspaceRoot,
      cwd: requestedCwd,
      ...(typeof toolInput.timeoutMs === 'number' ? { timeoutMs: toolInput.timeoutMs } : {}),
      env: baseEnv,
      signal,
      invocationId: input.invocationId,
      correlation: input.correlation,
      workspace: {
        id: input.workspace.id,
        userId: input.workspace.userId,
        username: input.workspace.username,
        sessionId: input.workspace.sessionId,
      },
      stream: input.stream === true,
      emit: (chunk) => emit({ kind: 'chunk', chunk }),
      executionRequested: toolInput.execution === 'snapshot' ? 'snapshot' : 'workspace',
      ...(autoSnapshotReason ? { executionRoutingReason: autoSnapshotReason } : {}),
    });
    if (input.stream) emit({ kind: 'chunk', chunk: { type: 'completed', response } });
    else emit({ kind: 'final', response });
    return;
  }
  const snapshot = shouldUseSnapshot
    ? await prepareSnapshotExecution({
        workspaceRoot,
        command: effectiveCommand,
        cwd: requestedCwd,
        signal,
        env: baseEnv,
        progress: (message) => emit({ kind: 'chunk', chunk: { type: 'progress', message } }),
      })
    : undefined;
  const effectiveRoot = snapshot?.root
    ?? (localToolName === 'Shell' ? await resolveExecutionCwd(workspaceRoot, requestedCwd) : workspaceRoot);
  const effectiveEnv = snapshot?.env ?? baseEnv;
  const workspace: WorkspaceRef = {
    id: input.workspace.id,
    root: effectiveRoot,
    userId: input.workspace.userId,
    username: input.workspace.username,
    sessionId: input.workspace.sessionId,
    ...(input.workspace.sharedReadOnlyMounted
      ? { sharedReadOnlyRoot: resolveMountedSharedReadOnlyRoot(process.env.AGENT_SHARED_READ_ONLY_PATH) }
      : {}),
    executionTarget: 'server-local',
  };
  const provider = new ServerLocalExecutionProvider({ envBuilder: () => effectiveEnv });
  const runtimeToolInput = workspaceRoutingReason && typeof effectiveToolInput === 'object' && effectiveToolInput
    ? { ...effectiveToolInput, execution: 'workspace' }
    : effectiveToolInput;
  const request = {
    toolName: localToolName,
    input: runtimeToolInput,
    context: {
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      ...(input.correlation ? { correlation: input.correlation } : {}),
      workspace,
      signal,
    },
  };

  try {
    if (localToolName === 'Shell' && provider.executeStream) {
      for await (const chunk of provider.executeStream(request)) {
        const enriched = chunk.type === 'completed'
          ? {
              ...chunk,
              response: snapshot
                ? addSnapshotMetadata(chunk.response, snapshot.metadata, autoSnapshotReason)
                : workspaceRoutingReason
                  ? addWorkspaceRoutingMetadata(chunk.response, workspaceRoutingReason)
                  : chunk.response,
            }
          : chunk;
        if (input.stream) emit({ kind: 'chunk', chunk: enriched as ToolInvocationStreamChunk });
        else if (enriched.type === 'completed') emit({ kind: 'final', response: enriched.response });
      }
      return;
    }

    const response = await provider.execute(request);
    emit({
      kind: 'final',
      response: snapshot
        ? addSnapshotMetadata(response, snapshot.metadata, autoSnapshotReason)
        : workspaceRoutingReason
          ? addWorkspaceRoutingMetadata(response, workspaceRoutingReason)
          : response,
    });
  } finally {
    await snapshot?.cleanup().catch(() => undefined);
  }
}

export function resolveMountedSharedReadOnlyRoot(value: string | undefined): string {
  if (!value || !isAbsolute(value)) {
    throw new Error('组织共享只读目录已声明挂载，但 AGENT_SHARED_READ_ONLY_PATH 无效');
  }
  return resolve(value);
}

export function normalizeShellCommandForCwd(command: string, cwd: string | undefined): string {
  if (!cwd) return command;
  const prelude = command.match(/^(?:\s*set\s+(?:-[a-zA-Z]+|-o\s+[a-zA-Z0-9_-]+)\s*(?:;|\n))*/)?.[0] ?? '';
  const remainder = command.slice(prelude.length);
  const match = remainder.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;|\n)\s*/);
  const commandCwd = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!match || !commandCwd || normalizeComparableCwd(commandCwd) !== normalizeComparableCwd(cwd)) return command;
  return `${prelude}${remainder.slice(match[0].length)}`;
}

function normalizeComparableCwd(value: string): string {
  return normalize(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '') || '.';
}

export function addSnapshotMetadata(
  response: ToolInvocationResponse,
  snapshotExecution: SnapshotExecutionMetadata,
  routingReason?: SnapshotAutoRoutingReason,
): ToolInvocationResponse {
  const commandMs = typeof response.metadata?.durationMs === 'number' ? response.metadata.durationMs : undefined;
  const enriched = commandMs === undefined
    ? snapshotExecution
    : { ...snapshotExecution, commandMs, totalMs: snapshotExecution.preparationMs + commandMs };
  const flatMetadata = {
    executionRequested: routingReason ? 'workspace' : enriched.requested,
    executionUsed: enriched.used,
    ...(routingReason ? { executionRoutingReason: routingReason } : {}),
    snapshotPreparationMs: enriched.preparationMs,
    ...(enriched.repositoryPath ? { snapshotRepositoryPath: enriched.repositoryPath } : {}),
    ...(enriched.sourceCwd ? { snapshotSourceCwd: enriched.sourceCwd } : {}),
    ...(enriched.sourceRevision ? { snapshotSourceRevision: enriched.sourceRevision } : {}),
    ...(enriched.dirtyFileCount !== undefined ? { snapshotDirtyFileCount: enriched.dirtyFileCount } : {}),
    ...(enriched.snapshotMs !== undefined ? { snapshotMaterializationMs: enriched.snapshotMs } : {}),
    ...(enriched.dependencyMs !== undefined ? { snapshotDependencyMs: enriched.dependencyMs } : {}),
    ...(enriched.dependencyCacheHit !== undefined ? { snapshotDependencyCacheHit: enriched.dependencyCacheHit } : {}),
    ...(enriched.totalMs !== undefined ? { executionTotalMs: enriched.totalMs } : {}),
  };
  const routingNote = routingReason
    ? `；已将持久工作区请求确定性改道：${routingReason === 'snapshot_dependency_restore' ? '依赖恢复不写入工作区' : '纯验证无需保留产物'}`
    : '';
  const note = `[执行位置] 容器临时盘快照；准备 ${enriched.preparationMs}ms${enriched.dependencyCacheHit === undefined ? '' : `，依赖缓存${enriched.dependencyCacheHit ? '命中' : '新建'}`}${routingNote}`;
  return response.status === 'success'
    ? {
        ...response,
        content: `${response.content}\n\n${note}`,
        metadata: { ...(response.metadata ?? {}), ...flatMetadata, snapshotExecution: enriched },
      }
    : {
        ...response,
        error: `${response.error}\n\n${note}`,
        metadata: { ...(response.metadata ?? {}), ...flatMetadata, snapshotExecution: enriched },
      };
}

export function addWorkspaceRoutingMetadata(
  response: ToolInvocationResponse,
  reason: SnapshotWorkspaceRoutingReason,
): ToolInvocationResponse {
  const durationMs = typeof response.metadata?.durationMs === 'number' ? response.metadata.durationMs : undefined;
  const metadata = {
    ...(response.metadata ?? {}),
    executionRequested: 'snapshot',
    executionUsed: 'workspace',
    executionRoutingReason: reason,
    ...(durationMs === undefined ? {} : { executionTotalMs: durationMs }),
  };
  const explanation = reason === 'workspace_git_remote_refresh'
    ? 'Git 远端引用刷新需要保留结果'
    : '命令只读取持久工作区';
  const note = `[执行位置] 持久工作区；已将 snapshot 请求确定性改道：${explanation}`;
  return response.status === 'success'
    ? { ...response, content: `${response.content}\n\n${note}`, metadata }
    : { ...response, error: `${response.error}\n\n${note}`, metadata };
}

export function createCachedPythonEnvEnsurer(
  ensure: (workspaceRoot: string) => unknown = ensurePythonEnv,
): (workspaceRoot: string) => Promise<void> {
  const readyByWorkspace = new Map<string, Promise<void>>();
  return async (workspaceRoot: string): Promise<void> => {
    let ready = readyByWorkspace.get(workspaceRoot);
    if (!ready) {
      ready = Promise.resolve().then(() => { ensure(workspaceRoot); });
      readyByWorkspace.set(workspaceRoot, ready);
      void ready.catch(() => {
        // 失败只影响本次调用；否则 rejected Promise 会让该 workspace 在 daemon
        // 生命周期内永久失败。仅删除仍指向本 Promise 的条目，避免误删后继重试。
        if (readyByWorkspace.get(workspaceRoot) === ready) readyByWorkspace.delete(workspaceRoot);
      });
    }
    await ready;
  };
}

async function main(): Promise<void> {
  if (process.argv.includes('--daemon')) {
    const ensurePythonEnvReady = createCachedPythonEnvEnsurer();
    await runSandboxRunnerDaemon({
      imageRef: process.env.ACS_SANDBOX_IMAGE,
      execute: async (input, signal, emit) => {
        if (input.toolName !== '__FeishuCli') {
          const workspaceRoot = input.workspace.root || process.env.ACS_WORKSPACE_PATH || '/workspace';
          await ensurePythonEnvReady(workspaceRoot);
        }
        await executeSandboxRunnerInput(input, signal, emit, { skipPythonEnv: true });
      },
    });
    return;
  }
  const raw = await readStdin();
  const input = JSON.parse(raw || '{}') as SandboxRunnerInput;
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  process.once('SIGHUP', abort);
  try {
    await executeSandboxRunnerInput(input, abortController.signal, writeJsonLine);
  } finally {
    process.removeListener('SIGTERM', abort);
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGHUP', abort);
  }
}

/**
 * 飞书连接器控制面专用入口。
 *
 * 不进入 WORKSPACE_HAND_TOOLS，也不复用通用 Shell：App Secret 只经受信 Server→ACS
 * 请求进入本进程内存，并通过 stdin 交给官方 lark-cli；不会出现在 argv、sandbox env、
 * Agent transcript 或工具审计中。业务期调用仍由 Agent 通过通用 Shell 执行 lark-cli。
 */
export function executeFeishuCli(input: unknown, workspaceRoot: string): ToolInvocationResponse {
  const args = input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const operation = typeof args.operation === 'string' ? args.operation : '';
  const profile = boundedCliValue(args.profile, 'profile', 64, /^[A-Za-z0-9._-]+$/);
  const env = {
    ...(process.env as Record<string, string | undefined>),
    LARKSUITE_CLI_CONFIG_DIR: join(workspaceRoot, '.lark-cli', 'config'),
    LARKSUITE_CLI_DATA_DIR: join(workspaceRoot, '.lark-cli', 'data'),
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  } as Record<string, string>;

  try {
    if (operation === 'init') {
      const appId = boundedCliValue(args.appId, 'appId', 256, /^[A-Za-z0-9._-]+$/);
      const appSecret = typeof args.appSecret === 'string' ? args.appSecret.trim() : '';
      if (!appSecret || appSecret.length > 4_096 || /[\r\n\0]/.test(appSecret)) {
        throw new Error('appSecret 必须为 1-4096 字符且不能包含换行或 NUL');
      }
      return runFeishuCli([
        'config', 'init',
        '--app-id', appId,
        '--app-secret-stdin',
        '--brand', 'feishu',
        '--name', profile,
      ], workspaceRoot, env, 60_000, `${appSecret}\n`);
    }
    if (operation === 'start_auth') {
      return runFeishuCli([
        '--profile', profile,
        'auth', 'login', '--domain', 'all', '--no-wait', '--json',
      ], workspaceRoot, env, 60_000);
    }
    if (operation === 'complete_auth') {
      const deviceCode = boundedCliValue(args.deviceCode, 'deviceCode', 1_024, /^[A-Za-z0-9._~-]+$/);
      return runFeishuCli([
        '--profile', profile,
        'auth', 'login', '--device-code', deviceCode, '--json',
      ], workspaceRoot, env, 11 * 60_000);
    }
    if (operation === 'status') {
      return runFeishuCli([
        '--profile', profile,
        'auth', 'status', '--verify', '--json',
      ], workspaceRoot, env, 60_000);
    }
    return { status: 'error', error: '不支持的飞书 CLI 内部操作' };
  } catch (err) {
    return { status: 'error', error: redactFeishuCliError(err) };
  }
}

function runFeishuCli(
  args: string[],
  workspaceRoot: string,
  env: Record<string, string>,
  timeoutMs: number,
  stdin?: string,
): ToolInvocationResponse {
  try {
    const stdout = execFileSync('lark-cli', args, {
      cwd: workspaceRoot,
      env,
      encoding: 'utf-8',
      input: stdin,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 'success', content: stdout.trim() };
  } catch (err) {
    const childError = err as Error & { stdout?: string | Buffer; stderr?: string | Buffer; status?: number };
    const stdout = childError.stdout ? String(childError.stdout).trim() : '';
    const stderr = childError.stderr ? String(childError.stderr).trim() : '';
    const detail = [stdout, stderr].filter(Boolean).join('\n');
    return {
      status: 'error',
      error: redactFeishuCliError(detail || childError.message),
      metadata: { exitCode: typeof childError.status === 'number' ? childError.status : null },
    };
  }
}

function boundedCliValue(
  value: unknown,
  name: string,
  maxLength: number,
  pattern: RegExp,
): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > maxLength || !pattern.test(text)) throw new Error(`${name} 格式无效`);
  return text;
}

function redactFeishuCliError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:app[_-]?secret|access[_-]?token|refresh[_-]?token|device[_-]?code|authorization)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/https:\/\/[^\s"']*feishu\.cn\/[^\s"']+/gi, '[FEISHU_AUTH_URL_REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_000) || 'unknown_error';
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
        commandCwd: await resolveExecutionCwd(
          input.workspaceRoot,
          typeof args.cwd === 'string' ? args.cwd : undefined,
        ),
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
    if (input.toolName === '__BackgroundShellFailClosed') {
      if (!Array.isArray(args.task_ids) || args.task_ids.some((taskId) => typeof taskId !== 'string')) {
        return { status: 'error', error: '__BackgroundShellFailClosed 需要字符串 task_ids。' };
      }
      try {
        const remaining = await terminateBackgroundShellsFailClosed(
          input.workspaceRoot,
          args.task_ids as string[],
        );
        return {
          status: 'success',
          content: JSON.stringify(remaining),
          metadata: { backgroundShell: remaining },
        };
      } catch (error) {
        const remaining = await reconcileBackgroundShells(input.workspaceRoot);
        return {
          status: 'error',
          error: `后台保护持久化失败且仍有进程未终止: ${error instanceof Error ? error.message : String(error)}`,
          metadata: { backgroundShell: remaining },
        };
      }
    }
    if (input.toolName === '__BackgroundShellReconcile') {
      const result = await reconcileBackgroundShells(input.workspaceRoot, { strict: args.fail_closed === true });
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

function backgroundShellResponse(output: BackgroundShellOutput): ToolInvocationResponse {
  return {
    status: 'success',
    content: JSON.stringify(output),
    metadata: {
      backgroundShell: {
        taskId: output.taskId,
        status: output.status,
        ...(output.protectedUntil ? { protectedUntil: output.protectedUntil } : {}),
        ...(typeof output.requestOwned === 'boolean' ? { requestOwned: output.requestOwned } : {}),
        activeTaskIds: output.activeTaskIds,
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
    // 2026-08-01 生产事故修复：venv rebuild 必须跨进程互斥。每次 kubectl exec 都是
    // 独立 runner 进程，兼容契约变化后多个并发 runner 同时 rebuild 会互相踩
    //（A archive 旧 venv 时 B 正在 python -m venv → File exists /
    // ensurepip 半成品 / pip install 中文件被 archive 走），且每次失败留下的残缺
    // venv 让后续每个 runner 都再触发 rebuild，形成自激循环（2026-08-01 00:59
    // kaiyan 生产实发，hand 连续 unhealthy）。锁用 mkdir 原子性（NFS 服务端原子），
    // 等待方拿到机会后先重查健康（多数情况持有者已修好，直接复用零重建）。
    const recheck = () => venvRebuildReasons({
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
    const lock = acquireVenvRebuildLock(workspaceRoot, {
      waitMs: options.rebuildLockWaitMs ?? 300_000,
      staleMs: options.rebuildLockStaleMs ?? 900_000,
      isHealthy: () => recheck().length === 0,
    });
    try {
      const reasonsUnderLock = recheck();
      if (reasonsUnderLock.length > 0) {
        if (!lock.acquired) {
          throw new Error(
            `venv rebuild lock busy and venv still unhealthy (${reasonsUnderLock.join(',')}); retry shortly`,
          );
        }
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
    } finally {
      lock.release();
    }
  }
  configurePythonEnv(venvPath, pipCacheDir);
  return { venvPath, pythonPath, pipCacheDir, manifestPath, rebuilt, rebuildReasons };
}

interface VenvRebuildLock {
  acquired: boolean;
  release(): void;
}

/**
 * venv rebuild 跨进程锁（mkdir 原子性，NFS 安全）。
 * - 抢到：返回 acquired=true，release() 删除锁目录；
 * - 他人持有：轮询等待。期间 isHealthy() 变 true（持有者修好了）即提前返回
 *   acquired=false，调用方直接复用；
 * - stale：锁目录 mtime 超过 staleMs（持有者进程被杀）→ 删除后重抢；
 * - 等满 waitMs 仍未获得：返回 acquired=false，由调用方决定（仍不健康则报错，
 *   宁可本次工具失败重试，也不能带病并发 rebuild）。
 */
function acquireVenvRebuildLock(
  workspaceRoot: string,
  input: { waitMs: number; staleMs: number; isHealthy: () => boolean },
): VenvRebuildLock {
  const lockDir = join(workspaceRoot, '.ky-agent', 'runtime', 'venv-rebuild.lock');
  const deadline = Date.now() + Math.max(0, input.waitMs);
  const noopRelease = () => {};
  for (;;) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, 'utf-8');
      } catch {
        // owner 信息仅诊断用，写失败不影响锁语义。
      }
      let released = false;
      return {
        acquired: true,
        release: () => {
          if (released) return;
          released = true;
          rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // 锁被他人持有：健康即可提前退出（持有者已完成 rebuild）。
    if (input.isHealthy()) return { acquired: false, release: noopRelease };
    try {
      const stat = statSync(lockDir);
      if (Date.now() - stat.mtimeMs > input.staleMs) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch {
      continue; // 锁刚被释放，立刻重试抢锁。
    }
    if (Date.now() >= deadline) return { acquired: false, release: noopRelease };
    sleepSync(1_000 + Math.floor(Math.random() * 500));
  }
}

/** 同步 sleep（runner 是每次 exec 一个的独立进程，同步等待无副作用）。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
  // imageRef 仅用于诊断 venv 最初由哪个 Sandbox 镜像创建。无关镜像发布不改变
  // Python ABI / base requirements / venv 隔离性，不能据此重建共享 NAS 上的可变环境。
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
    '--no-compile',
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
