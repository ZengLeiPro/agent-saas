import { randomUUID } from 'crypto';
import { execFile as execFileCb, spawn } from 'child_process';
import { isAbsolute, relative, resolve } from 'path';
import { promisify } from 'util';

import type {
  EnvBuilder,
  ExecutionInvocationAudit,
  ExecutionProvider,
  ToolDescriptor,
  WorkspaceRef,
} from './toolRuntime.js';
import { WORKSPACE_HAND_TOOLS } from './toolRuntime.js';
import { createEditDiff } from './editOperations.js';
import { parseProvablyReadOnlyRgCommand } from './shellReadOnlyPolicy.js';
import {
  MAX_ARTIFACT_PAYLOAD_BYTES,
  MAX_READ_IMAGE_SOURCE_BYTES,
  WORKSPACE_ARTIFACT_PAYLOAD_METADATA_KEY,
  WORKSPACE_READ_IMAGE_PAYLOAD_METADATA_KEY,
} from './workspaceHandTools.js';
import { persistShellOutputFiles, shellOutputBaseName } from './shellOutputFiles.js';
import { ShellChannelAccumulator } from './shellOutputAccumulator.js';
import { createThrottledShellProgress, LimitedUtf8Decoder } from './shellProgressEmitter.js';
import { withWorkspaceFileMutationQueue } from './workspaceFileMutationQueue.js';
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MAX_READ_LINES,
  MAX_READ_OUTPUT_BYTES,
  MAX_SHELL_SPILL_BYTES,
  SHELL_PROGRESS_SNAPSHOT_INTERVAL_MS,
  SHELL_PROGRESS_SNAPSHOT_MAX_CHARS,
  formatShellOutput,
  type ShellOutputFileRef,
} from './toolOutput.js';
import type {
  ToolInvocationRequest,
  ToolInvocationResponse,
  ToolInvocationStream,
  ToolInvocationStreamChunk,
} from '../runtime/handProtocol.js';
import {
  DEFAULT_ISOLATED_NETWORK_POLICY,
  dockerNetworkPolicyStatus,
  normalizeNetworkPolicy,
  resolveDockerNetworkName,
  type NetworkPolicyConfig,
  type NetworkPolicyStatus,
} from '../runtime/networkPolicy.js';

const execFile = promisify(execFileCb);

const MAX_CONTAINER_HELPER_OUTPUT = Math.ceil(
  Math.max(MAX_ARTIFACT_PAYLOAD_BYTES, MAX_READ_IMAGE_SOURCE_BYTES) * 1.4,
) + 64 * 1024;
const DEFAULT_CONTAINER_IMAGE = 'node:22-bookworm-slim';
const DEFAULT_CONTAINER_FILE_HELPER_TIMEOUT_MS = 30_000;
const DEFAULT_CONTAINER_SHELL_TIMEOUT_MS = DEFAULT_SHELL_TIMEOUT_MS;
const DEFAULT_CONTAINER_WORKDIR = '/workspace';
const DEFAULT_CONTAINER_NAME_PREFIX = 'ky-agent-exec';
const DEFAULT_CONTAINER_NETWORK = 'none';
const DEFAULT_CONTAINER_CAP_DROP = ['ALL'];
const DEFAULT_CONTAINER_SECURITY_OPT = ['no-new-privileges'];
const DEFAULT_CONTAINER_TMPFS = ['/tmp:rw,nosuid,nodev,noexec,size=64m'];
const DEFAULT_CONTAINER_MEMORY = '1024m';
const DEFAULT_CONTAINER_CPUS = '1.0';
const DEFAULT_CONTAINER_PIDS_LIMIT = 256;

export interface ContainerExecutionProviderOptions {
  image?: string;
  dockerPath?: string;
  workdir?: string;
  containerNamePrefix?: string;
  /**
   * Backward-compatible default for both helper and shell timeouts.
   * Prefer fileHelperTimeoutMs/shellTimeoutMs for new call sites.
   */
  defaultTimeoutMs?: number;
  fileHelperTimeoutMs?: number;
  shellTimeoutMs?: number;
  env?: Record<string, string>;
  network?: string;
  networkPolicy?: NetworkPolicyConfig;
  capDrop?: string[];
  securityOpt?: string[];
  readOnly?: boolean;
  tmpfs?: string[];
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /**
   * P4 防御纵深（2026-06-22 落地）：按 workspace 动态装配子进程 env，
   * 注入到 `docker run --env KEY=VALUE` 列表。优先级高于 options.env（静态默认）。
   * 同时给组织用户在容器里补齐 per-tenant azeroth PAT（之前缺失：options.env={} →
   * 容器零 env → ky-azeroth CLI 报"未授权"）。
   */
  envBuilder?: EnvBuilder;
  user?: string;
}

export class ContainerExecutionProvider implements ExecutionProvider {
  private readonly image: string;
  private readonly dockerPath: string;
  private readonly workdir: string;
  private readonly containerNamePrefix: string;
  private readonly fileHelperTimeoutMs: number;
  private readonly shellTimeoutMs: number;
  private readonly env: Record<string, string>;
  private readonly networkPolicy: NetworkPolicyConfig;
  private readonly network: string;
  private readonly capDrop: string[];
  private readonly securityOpt: string[];
  private readonly readOnly: boolean;
  private readonly tmpfs: string[];
  private readonly memory?: string;
  private readonly cpus?: string;
  private readonly pidsLimit?: number;
  private readonly envBuilder?: EnvBuilder;
  private readonly user?: string;

  constructor(options: ContainerExecutionProviderOptions = {}) {
    this.image = options.image ?? process.env.KY_AGENT_CONTAINER_IMAGE ?? DEFAULT_CONTAINER_IMAGE;
    this.dockerPath = options.dockerPath ?? 'docker';
    this.workdir = options.workdir ?? DEFAULT_CONTAINER_WORKDIR;
    this.containerNamePrefix = options.containerNamePrefix ?? DEFAULT_CONTAINER_NAME_PREFIX;
    this.fileHelperTimeoutMs = options.fileHelperTimeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_CONTAINER_FILE_HELPER_TIMEOUT_MS;
    this.shellTimeoutMs = options.shellTimeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_CONTAINER_SHELL_TIMEOUT_MS;
    this.env = options.env ?? {};
    this.networkPolicy = normalizeNetworkPolicy(options.networkPolicy, DEFAULT_ISOLATED_NETWORK_POLICY);
    this.network = resolveDockerNetworkName(this.networkPolicy, options.network ?? DEFAULT_CONTAINER_NETWORK);
    this.capDrop = options.capDrop ?? DEFAULT_CONTAINER_CAP_DROP;
    this.securityOpt = options.securityOpt ?? DEFAULT_CONTAINER_SECURITY_OPT;
    this.readOnly = options.readOnly ?? true;
    this.tmpfs = options.tmpfs ?? DEFAULT_CONTAINER_TMPFS;
    this.memory = options.memory ?? process.env.KY_AGENT_CONTAINER_MEMORY ?? DEFAULT_CONTAINER_MEMORY;
    this.cpus = options.cpus ?? process.env.KY_AGENT_CONTAINER_CPUS ?? DEFAULT_CONTAINER_CPUS;
    this.pidsLimit = options.pidsLimit ?? Number.parseInt(process.env.KY_AGENT_CONTAINER_PIDS_LIMIT ?? String(DEFAULT_CONTAINER_PIDS_LIMIT), 10);
    this.envBuilder = options.envBuilder;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
    this.user = options.user ?? (uid !== undefined && gid !== undefined ? `${uid}:${gid}` : undefined);
  }

  listInternalTools(): ToolDescriptor[] {
    return WORKSPACE_HAND_TOOLS;
  }

  networkPolicyStatus(): NetworkPolicyStatus {
    return dockerNetworkPolicyStatus(this.networkPolicy, this.network);
  }

  async execute(request: ToolInvocationRequest): Promise<ToolInvocationResponse> {
    const { toolName, input, context } = request;
    const { workspace, signal } = context;
    const audit: ExecutionInvocationAudit[] = [];
    try {
      switch (toolName) {
        case 'Read': {
          const args = input as { path: string; offset?: number; limit?: number };
          const result = await this.runNodeHelper(workspace, {
            op: 'readFile',
            path: workspaceRelativeInputPath(workspace.root, args.path),
            offset: args.offset,
            limit: args.limit,
          }, audit, { stdoutLimit: MAX_CONTAINER_HELPER_OUTPUT });
          return {
            status: 'success',
            content: result.content,
            audit,
            ...(result.metadata ? { metadata: result.metadata } : {}),
          };
        }
        case 'Write': {
          const args = input as { path: string; content: string };
          const relPath = workspaceRelativeInputPath(workspace.root, args.path);
          await withWorkspaceFileMutationQueue(workspace.root, relPath, async () => {
            await this.runNodeHelper(workspace, {
              op: 'writeFile',
              path: relPath,
              content: args.content,
            }, audit);
          });
          return {
            status: 'success',
            content: `wrote ${relPath} (${args.content.length} chars)`,
            audit,
            metadata: { path: relPath, bytesWritten: args.content.length },
          };
        }
        case 'Shell': {
          const args = input as { command: string; timeoutMs?: number };
          const spillBaseName = shellOutputBaseName(context.invocationId);
          const readOnlyArgv = parseProvablyReadOnlyRgCommand(args.command);
          const result = await this.runDocker(workspace, readOnlyArgv ?? ['/bin/sh', '-lc', args.command], {
            operation: 'runShell',
            timeoutMs: args.timeoutMs ?? this.shellTimeoutMs,
            stdoutLimit: MAX_SHELL_SPILL_BYTES,
            stderrLimit: MAX_SHELL_SPILL_BYTES,
            signal,
            allowNonZeroExit: true,
            returnOutputOnError: true,
            runtimeEnv: readOnlyArgv
              ? { ...context.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
              : context.env,
            capture: {
              stdout: new ShellChannelAccumulator('stdout', workspace.root, spillBaseName),
              stderr: new ShellChannelAccumulator('stderr', workspace.root, spillBaseName),
            },
          }, audit);
          const { outputFiles, outputFileError } = await this.mergeShellOutput(
            workspace,
            context.invocationId,
            spillBaseName,
            result,
          );
          const content = formatShellOutput({
            ...result,
            stdoutLines: result.stdoutLines,
            stderrLines: result.stderrLines,
            outputWindowTruncated: result.outputWindowTruncated,
            outputQuotaTerminated: result.outputQuotaTerminated,
            outputFiles,
            ...(outputFileError ? { outputFileError } : {}),
          });
          const metadata = {
            exitCode: result.exitCode,
            signal: result.signal,
            stdoutBytes: result.stdoutBytes,
            stderrBytes: result.stderrBytes,
            durationMs: result.durationMs,
            ...(result.timedOut ? { timedOut: true } : {}),
            ...(result.aborted ? { aborted: true } : {}),
            ...(result.outputExceeded ? { outputExceeded: true } : {}),
            ...(result.outputWindowTruncated ? { outputWindowTruncated: true } : {}),
            ...(result.outputQuotaTerminated ? { outputQuotaTerminated: true } : {}),
            ...(outputFiles.length > 0 ? { outputFiles } : {}),
            ...(outputFileError ? { outputFileError } : {}),
          };
          return result.error
            ? { status: 'error', error: `${result.error}\n\n${content}`, audit, metadata }
            : result.exitCode === 0
              ? { status: 'success', content, audit, metadata }
              : { status: 'error', error: `command exited ${result.exitCode ?? result.signal}\n\n${content}`, audit, metadata };
        }
        case 'Edit': {
          const args = input as {
            file_path: string;
            old_string?: string;
            new_string?: string;
            replace_all?: boolean;
            edits?: Array<{ old_string: string; new_string: string; replace_all?: boolean }>;
          };
          const relPath = workspaceRelativeInputPath(workspace.root, args.file_path);
          const result = await withWorkspaceFileMutationQueue(workspace.root, relPath, async () =>
            await this.runNodeHelper(workspace, {
              op: 'edit',
              file_path: relPath,
              old_string: args.old_string,
              new_string: args.new_string,
              replace_all: args.replace_all,
              edits: args.edits,
            }, audit, { stdoutLimit: MAX_CONTAINER_HELPER_OUTPUT }));
          const { beforeContent, afterContent, ...metadata } = result.metadata ?? {};
          if (typeof beforeContent !== 'string' || typeof afterContent !== 'string') {
            throw new Error('Container Edit helper omitted diff source content.');
          }
          let diff: Record<string, unknown>;
          try {
            diff = createEditDiff(String(metadata.path ?? args.file_path), beforeContent, afterContent);
          } catch {
            // 编辑已经由 helper 通过同一 fd 提交；可选 diff 生成失败不能把成功写入伪报成失败。
            diff = { diffUnavailable: true };
          }
          return {
            status: 'success',
            content: result.content,
            audit,
            metadata: { ...metadata, ...diff },
          };
        }
        case 'CreateArtifact': {
          const args = input as {
            file_path: string;
            kind?: string;
            mime_type?: string;
          };
          const result = await this.runNodeHelper(workspace, {
            op: 'artifactCreate',
            file_path: workspaceRelativeInputPath(workspace.root, args.file_path),
            kind: args.kind,
            mime_type: args.mime_type,
          }, audit, { stdoutLimit: MAX_CONTAINER_HELPER_OUTPUT });
          const payload = JSON.parse(result.content || '{}') as {
            sourcePath?: string;
            fileName?: string;
            sizeBytes?: number;
          };
          return {
            status: 'success',
            content: JSON.stringify({
              sourcePath: payload.sourcePath,
              fileName: payload.fileName,
              sizeBytes: payload.sizeBytes,
            }, null, 2),
            audit,
            metadata: { [WORKSPACE_ARTIFACT_PAYLOAD_METADATA_KEY]: payload },
          };
        }
        default:
          return {
            status: 'error',
            error: `ContainerExecutionProvider: unknown tool ${toolName}`,
            audit,
          };
      }
    } catch (err) {
      return {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        audit,
      };
    }
  }


  async *executeStream(request: ToolInvocationRequest): ToolInvocationStream {
    if (request.toolName !== 'Shell') {
      yield { type: 'completed', response: await this.execute(request) };
      return;
    }
    const audit: ExecutionInvocationAudit[] = [];
    const { input, context } = request;
    const { workspace, signal } = context;
    const args = input as { command: string; timeoutMs?: number };
    const queue: ToolInvocationStreamChunk[] = [];
    let done = false;
    let notify: (() => void) | undefined;
    const wake = () => { notify?.(); notify = undefined; };
    const push = (chunk: ToolInvocationStreamChunk) => { queue.push(chunk); wake(); };
    const spillBaseName = shellOutputBaseName(context.invocationId);
    const stdoutAcc = new ShellChannelAccumulator('stdout', workspace.root, spillBaseName);
    const stderrAcc = new ShellChannelAccumulator('stderr', workspace.root, spillBaseName);
    const startedAt = Date.now();
    const progress = createThrottledShellProgress((message) => push({ type: 'progress', message }));
    const stdoutDecoder = new LimitedUtf8Decoder();
    const stderrDecoder = new LimitedUtf8Decoder();
    const buildHeartbeatMessage = (): string => {
      const stats = `running ${((Date.now() - startedAt) / 1000).toFixed(1)}s · stdout=${stdoutAcc.bytesReceived()} bytes · stderr=${stderrAcc.bytesReceived()} bytes`;
      const tailBudget = Math.floor(SHELL_PROGRESS_SNAPSHOT_MAX_CHARS / 2);
      const stdoutTail = stdoutAcc.tailSnapshot(tailBudget);
      const stderrTail = stderrAcc.tailSnapshot(tailBudget);
      const tails = [
        stdoutTail ? `[stdout tail]\n${stdoutTail}` : undefined,
        stderrTail ? `[stderr tail]\n${stderrTail}` : undefined,
      ].filter(Boolean).join('\n');
      return tails ? `${stats}\n${tails}` : stats;
    };
    const heartbeat = setInterval(() => {
      if (!done) progress.maybeEmitSnapshot(buildHeartbeatMessage);
    }, SHELL_PROGRESS_SNAPSHOT_INTERVAL_MS);
    heartbeat.unref?.();
    const readOnlyArgv = parseProvablyReadOnlyRgCommand(args.command);
    this.runDocker(workspace, readOnlyArgv ?? ['/bin/sh', '-lc', args.command], {
      operation: 'runShell',
      timeoutMs: args.timeoutMs ?? this.shellTimeoutMs,
      stdoutLimit: MAX_SHELL_SPILL_BYTES,
      stderrLimit: MAX_SHELL_SPILL_BYTES,
      signal,
      allowNonZeroExit: true,
      returnOutputOnError: true,
      runtimeEnv: readOnlyArgv
        ? { ...context.env, PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' }
        : context.env,
      capture: { stdout: stdoutAcc, stderr: stderrAcc },
      onOutput: (channel, chunk) => {
        const allowed = progress.allowRaw(chunk.length);
        const decoder = channel === 'stdout' ? stdoutDecoder : stderrDecoder;
        // allowed=0 时仍调用，用当前 chunk 补齐预算边界前未完成的 UTF-8 字符。
        const content = decoder.decode(chunk, allowed);
        if (content) push({ type: 'output', channel, content });
        if (progress.isRawExhausted()) progress.notifyRawExhausted();
      },
    }, audit)
      .then(async (result) => {
        const { outputFiles, outputFileError } = await this.mergeShellOutput(
          workspace,
          context.invocationId,
          spillBaseName,
          result,
        );
        const content = formatShellOutput({
          ...result,
          stdoutLines: result.stdoutLines,
          stderrLines: result.stderrLines,
          outputWindowTruncated: result.outputWindowTruncated,
          outputQuotaTerminated: result.outputQuotaTerminated,
          outputFiles,
          ...(outputFileError ? { outputFileError } : {}),
        });
        const metadata = {
          exitCode: result.exitCode,
          signal: result.signal,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          durationMs: result.durationMs,
          ...(result.timedOut ? { timedOut: true } : {}),
          ...(result.aborted ? { aborted: true } : {}),
          ...(result.outputExceeded ? { outputExceeded: true } : {}),
          ...(result.outputWindowTruncated ? { outputWindowTruncated: true } : {}),
          ...(result.outputQuotaTerminated ? { outputQuotaTerminated: true } : {}),
          ...(outputFiles.length > 0 ? { outputFiles } : {}),
          ...(outputFileError ? { outputFileError } : {}),
        };
        push({
          type: 'completed',
          response: result.error
            ? { status: 'error', error: `${result.error}\n\n${content}`, audit, metadata }
            : result.exitCode === 0
              ? { status: 'success', content, audit, metadata }
              : { status: 'error', error: `command exited ${result.exitCode ?? result.signal}\n\n${content}`, audit, metadata },
        });
      })
      .catch((err) => push({ type: 'completed', response: { status: 'error', error: err instanceof Error ? err.message : String(err), audit } }))
      .finally(() => { clearInterval(heartbeat); done = true; wake(); });
    while (!done || queue.length > 0) {
      const chunk = queue.shift();
      if (chunk) { yield chunk; continue; }
      await new Promise<void>((resolve) => { notify = resolve; });
    }
  }

  private async mergeShellOutput(
    workspace: WorkspaceRef,
    invocationId: string | undefined,
    spillBaseName: string,
    result: {
      stdout: string;
      stderr: string;
      error?: string;
      timedOut?: boolean;
      aborted?: boolean;
      outputQuotaTerminated?: boolean;
      stdoutWindowTruncated?: boolean;
      stderrWindowTruncated?: boolean;
      spillFiles?: ShellOutputFileRef[];
      spillError?: string;
    },
  ): Promise<{ outputFiles: ShellOutputFileRef[]; outputFileError?: string }> {
    const spillByChannel = new Map((result.spillFiles ?? []).map((file) => [file.channel, file]));
    let persisted: ShellOutputFileRef[] = [];
    let persistError: string | undefined;
    try {
      persisted = await persistShellOutputFiles({
        workspaceRoot: workspace.root,
        invocationId,
        baseName: spillBaseName,
        // 已截窗的通道只能引用累加器写出的全量文件；绝不能把窗口摘要覆盖成
        // “完整输出”。若溢出写盘失败，保留 spillError 明示失败。
        stdout: result.stdoutWindowTruncated ? '' : result.stdout,
        stderr: result.stderrWindowTruncated ? '' : result.stderr,
        force: Boolean(result.error || result.timedOut || result.aborted || result.outputQuotaTerminated),
      });
    } catch (err) {
      persistError = err instanceof Error ? err.message : String(err);
    }
    const persistedByChannel = new Map(persisted.map((file) => [file.channel, file]));
    const outputFiles = (['stdout', 'stderr'] as const)
      .map((channel) => spillByChannel.get(channel) ?? persistedByChannel.get(channel))
      .filter((file): file is ShellOutputFileRef => Boolean(file));
    const outputFileError = [result.spillError, persistError].filter(Boolean).join('; ') || undefined;
    return { outputFiles, ...(outputFileError ? { outputFileError } : {}) };
  }

  private async runNodeHelper(
    workspace: WorkspaceRef,
    request: Record<string, unknown> & { op: string },
    audit: ExecutionInvocationAudit[],
    options: { stdoutLimit?: number } = {},
  ): Promise<{ content: string; metadata?: Record<string, unknown> }> {
    const result = await this.runDocker(workspace, ['node', '-e', CONTAINER_FILE_HELPER_SCRIPT], {
      operation: request.op,
      input: JSON.stringify(request),
      timeoutMs: this.fileHelperTimeoutMs,
      stdoutLimit: options.stdoutLimit ?? MAX_FILE_BYTES + 4096,
      stderrLimit: 16 * 1024,
    }, audit);
    let parsed: { ok?: boolean; content?: string; error?: string; metadata?: Record<string, unknown> };
    try {
      parsed = JSON.parse(result.stdout.trim() || '{}') as {
        ok?: boolean;
        content?: string;
        error?: string;
        metadata?: Record<string, unknown>;
      };
    } catch (err) {
      throw new Error(`Container helper returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!parsed.ok) {
      throw new Error(parsed.error || 'Container helper failed');
    }
    return {
      content: parsed.content ?? '',
      ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
    };
  }

  private async runDocker(
    workspace: WorkspaceRef,
    command: string[],
    options: {
      operation: string;
      input?: string;
      timeoutMs: number;
      stdoutLimit: number;
      stderrLimit: number;
      signal?: AbortSignal;
      allowNonZeroExit?: boolean;
      returnOutputOnError?: boolean;
      onOutput?: (channel: 'stdout' | 'stderr', chunk: Buffer) => void;
      runtimeEnv?: Record<string, string>;
      /**
       * P0（2026-08-29）：Shell 专用输出累加器注入点。传入后输出不再全量驻留内存，
       * 改为头窗口 + 滚动尾窗 + 磁盘溢出，超限不终止命令（仅磁盘配额终止）。
       * 文件 helper（runNodeHelper）不传此参数，保持原内存捕获语义不受影响。
       */
      capture?: { stdout: ShellChannelAccumulator; stderr: ShellChannelAccumulator };
    },
    audit: ExecutionInvocationAudit[],
  ): Promise<{
    stdout: string;
    stderr: string;
    stdoutBytes: number;
    stderrBytes: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    durationMs: number;
    error?: string;
    timedOut?: boolean;
    aborted?: boolean;
    /** capture 模式：窗口截断或磁盘配额终止时为 true（语义由调用方按两子字段细分）。 */
    outputExceeded?: boolean;
    stdoutLines?: number;
    stderrLines?: number;
    stdoutWindowTruncated?: boolean;
    stderrWindowTruncated?: boolean;
    outputWindowTruncated?: boolean;
    outputQuotaTerminated?: boolean;
    spillFiles?: ShellOutputFileRef[];
    spillError?: string;
  }> {
    const name = `${this.containerNamePrefix}-${randomUUID()}`;
    const dockerArgs = [
      'run',
      '--rm',
      '--interactive',
      '--name',
      name,
      '--network',
      this.network,
      '--mount',
      `type=bind,src=${resolve(workspace.root)},dst=${this.workdir}`,
      '--workdir',
      this.workdir,
      '--env',
      'HOME=/tmp/ky-agent-home',
      '--env',
      `KY_AGENT_WORKDIR=${this.workdir}`,
    ];
    if (this.readOnly) dockerArgs.push('--read-only');
    for (const item of this.tmpfs) dockerArgs.push('--tmpfs', item);
    for (const item of this.capDrop) dockerArgs.push('--cap-drop', item);
    for (const item of this.securityOpt) dockerArgs.push('--security-opt', item);
    if (this.memory) dockerArgs.push('--memory', this.memory);
    if (this.cpus) dockerArgs.push('--cpus', this.cpus);
    if (this.pidsLimit && Number.isFinite(this.pidsLimit) && this.pidsLimit > 0) {
      dockerArgs.push('--pids-limit', String(this.pidsLimit));
    }
    if (this.user) dockerArgs.push('--user', this.user);
    // P4 防御纵深：优先 envBuilder（按 workspace.tenantId 装配 per-tenant env），
    // 缺省 fallback this.env 静态默认；保证当注入 envBuilder 后旧的 options.env 不会
    // 越过 tenant 装配漏密钥。
    const computedEnv = {
      ...(this.envBuilder ? this.envBuilder(workspace) : this.env),
      ...(options.runtimeEnv ?? {}),
    };
    for (const [key, value] of Object.entries(computedEnv)) {
      dockerArgs.push('--env', `${key}=${value}`);
    }
    dockerArgs.push(this.image, ...command);

    const child = spawn(this.dockerPath, dockerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
    });
    const startedAt = Date.now();
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    let outputStorageError: string | undefined;
    let terminationReason: 'timeout' | 'aborted' | 'quota' | 'spill' | undefined;
    let spawnError: unknown;
    let terminationStarted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = async () => {
      try {
        await execFile(this.dockerPath, ['rm', '-f', name], {
          timeout: 10_000,
          env: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
        });
      } catch {
        // --rm may already have removed the container.
      }
    };

    const terminate = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      killTimer.unref?.();
    };
    const handleSpillFailure = (message: string) => {
      if (outputStorageError) return;
      outputStorageError = message;
      terminationReason ??= 'spill';
      terminate();
    };
    const removeStdoutSpillHandler = options.capture?.stdout.onSpillFailure(handleSpillFailure);
    const removeStderrSpillHandler = options.capture?.stderr.onSpillFailure(handleSpillFailure);

    const timer = setTimeout(() => {
      if (terminationStarted) return;
      timedOut = true;
      terminationReason = 'timeout';
      terminate();
    }, options.timeoutMs);
    timer.unref();

    const abortListener = () => {
      if (terminationStarted) return;
      aborted = true;
      terminationReason = 'aborted';
      terminate();
    };
    options.signal?.addEventListener('abort', abortListener, { once: true });
    if (options.signal?.aborted) abortListener();

    const captureChunk = (
      channel: 'stdout' | 'stderr',
      chunk: Buffer,
      source: NodeJS.ReadableStream & { pause(): unknown; resume(): unknown; isPaused(): boolean },
    ) => {
      const accumulator = channel === 'stdout' ? options.capture?.stdout : options.capture?.stderr;
      if (channel === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (accumulator) {
        const feedResult = accumulator.feed(chunk);
        if (feedResult.backpressured && !source.isPaused()) {
          source.pause();
          void accumulator.waitUntilWritable().then(() => {
            if (!terminationStarted && !outputStorageError) source.resume();
          });
        }
        if (feedResult.spillFailed) {
          handleSpillFailure('failed to write output spill file');
          return;
        }
        if (feedResult.quotaExceeded) {
          if (!terminationStarted) {
            outputExceeded = true;
            terminationReason = 'quota';
            terminate();
          }
          return;
        }
      } else {
        const bytes = channel === 'stdout' ? stdoutBytes : stderrBytes;
        const limit = channel === 'stdout' ? options.stdoutLimit : options.stderrLimit;
        if (bytes > limit) {
          outputExceeded = true;
          terminate();
          return;
        }
        const text = chunk.toString('utf-8');
        if (channel === 'stdout') stdout += text;
        else stderr += text;
      }
      options.onOutput?.(channel, chunk);
    };
    child.stdout.on('data', (chunk: Buffer) => captureChunk('stdout', chunk, child.stdout));
    child.stderr.on('data', (chunk: Buffer) => captureChunk('stderr', chunk, child.stderr));

    child.stdin.end(options.input ?? '');

    let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    try {
      exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
        child.once('error', rejectExit);
        child.once('close', (code, signal) => resolveExit({ code, signal }));
      });
    } catch (err) {
      spawnError = err;
    } finally {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abortListener);
    }
    if (terminationStarted || spawnError) await cleanup();

    // capture 模式收尾：窗口内容 + 增量统计 + 溢出文件引用；未捕获通道保持内存全量。
    let stdoutResult = stdout;
    let stderrResult = stderr;
    let stdoutBytesResult = stdoutBytes;
    let stderrBytesResult = stderrBytes;
    let stdoutLines: number | undefined;
    let stderrLines: number | undefined;
    let stdoutWindowTruncated = false;
    let stderrWindowTruncated = false;
    let windowTruncated = false;
    const quotaTerminated = options.capture ? terminationReason === 'quota' : outputExceeded;
    let spillFiles: ShellOutputFileRef[] | undefined;
    let spillError: string | undefined;
    if (options.capture) {
      const [stdoutFinal, stderrFinal] = await Promise.all([
        options.capture.stdout.finalize(),
        options.capture.stderr.finalize(),
      ]);
      stdoutResult = stdoutFinal.content;
      stderrResult = stderrFinal.content;
      stdoutBytesResult = stdoutFinal.totalBytes;
      stderrBytesResult = stderrFinal.totalBytes;
      stdoutLines = stdoutFinal.lines;
      stderrLines = stderrFinal.lines;
      stdoutWindowTruncated = stdoutFinal.truncatedToWindow;
      stderrWindowTruncated = stderrFinal.truncatedToWindow;
      windowTruncated = stdoutWindowTruncated || stderrWindowTruncated;
      // outputQuotaTerminated 仅表示配额是首次终止原因；收尾残余字节越线不改写原因。
      spillFiles = [stdoutFinal.spillFile, stderrFinal.spillFile].filter((file): file is ShellOutputFileRef => Boolean(file));
      spillError = stdoutFinal.spillError ?? stderrFinal.spillError;
      outputStorageError = outputStorageError ?? spillError;
    }
    removeStdoutSpillHandler?.();
    removeStderrSpillHandler?.();

    const error = terminationReason === 'spill' && outputStorageError
      ? `Container command full-output persistence failed: ${outputStorageError}`
      : this.classifyDockerError({
          exit,
          spawnError,
          timedOut,
          outputExceeded: quotaTerminated,
          aborted,
          stdout: stdoutResult,
          stderr: stderrResult,
          timeoutMs: options.timeoutMs,
          allowNonZeroExit: options.allowNonZeroExit === true,
        });
    const durationMs = Date.now() - startedAt;
    audit.push({
      provider: 'server-container',
      operation: options.operation,
      image: this.image,
      containerName: name,
      timeoutMs: options.timeoutMs,
      stdoutBytes: stdoutBytesResult,
      stderrBytes: stderrBytesResult,
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
      status: error ? 'error' : 'success',
      ...(timedOut ? { timedOut: true } : {}),
      ...(windowTruncated || quotaTerminated ? { outputExceeded: true } : {}),
      ...(aborted ? { aborted: true } : {}),
      ...(error ? { error } : {}),
    } satisfies ExecutionInvocationAudit);

    const captureExtras = options.capture
      ? {
          stdoutLines,
          stderrLines,
          stdoutWindowTruncated,
          stderrWindowTruncated,
          outputWindowTruncated: windowTruncated,
          outputQuotaTerminated: quotaTerminated,
          ...(windowTruncated || quotaTerminated ? { outputExceeded: true } : {}),
          ...(spillFiles?.length ? { spillFiles } : {}),
          ...(spillError ? { spillError } : {}),
        }
      : {};

    if (error) {
      if (options.returnOutputOnError) {
        return {
          stdout: stdoutResult,
          stderr: stderrResult,
          stdoutBytes: stdoutBytesResult,
          stderrBytes: stderrBytesResult,
          exitCode: exit?.code ?? null,
          signal: exit?.signal ?? null,
          durationMs,
          error,
          ...(timedOut ? { timedOut: true } : {}),
          ...(aborted ? { aborted: true } : {}),
          ...(quotaTerminated ? { outputExceeded: true } : {}),
          ...captureExtras,
        };
      }
      throw new Error(error);
    }
    return {
      stdout: stdoutResult,
      stderr: stderrResult,
      stdoutBytes: stdoutBytesResult,
      stderrBytes: stderrBytesResult,
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
      durationMs,
      ...captureExtras,
    };
  }

  private classifyDockerError(args: {
    exit?: { code: number | null; signal: NodeJS.Signals | null };
    spawnError: unknown;
    timedOut: boolean;
    outputExceeded: boolean;
    aborted: boolean;
    stdout: string;
    stderr: string;
    timeoutMs: number;
    allowNonZeroExit: boolean;
  }): string | null {
    if (args.spawnError) {
      return `Container command failed to start: ${args.spawnError instanceof Error ? args.spawnError.message : String(args.spawnError)}`;
    }
    if (args.timedOut) {
      return `Container command timed out after ${args.timeoutMs}ms`;
    }
    if (args.outputExceeded) {
      return 'Container command output exceeded limit';
    }
    if (args.aborted) {
      return 'Container command aborted';
    }
    if (!args.allowNonZeroExit && args.exit && args.exit.code !== 0) {
      return `Container command exited ${args.exit.code ?? args.exit.signal}: ${args.stderr || args.stdout}`.trim();
    }
    return null;
  }
}

function isInside(baseDir: string, candidate: string): boolean {
  const rel = relative(baseDir, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function resolveWorkspacePath(cwd: string, inputPath: string): string {
  const fullPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);
  if (!isInside(cwd, fullPath)) {
    throw new Error(`Access denied: path outside workspace (${inputPath})`);
  }
  return fullPath;
}

function relativeWorkspacePath(cwd: string, fullPath: string): string {
  const rel = relative(cwd, fullPath);
  return rel || '.';
}

function workspaceRelativeInputPath(cwd: string, inputPath: string): string {
  const fullPath = resolveWorkspacePath(cwd, inputPath);
  return relativeWorkspacePath(cwd, fullPath);
}

const CONTAINER_EDIT_HELPER_SCRIPT = String.raw`
const editGraphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
function editStripBom(content) {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content };
}
function editDetectLineEnding(content) {
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/\n/g) || []).length - crlfCount;
  if (crlfCount === 0) return '\n';
  if (crlfCount !== lfCount) return crlfCount > lfCount ? '\r\n' : '\n';
  const firstNewline = content.indexOf('\n');
  return firstNewline > 0 && content[firstNewline - 1] === '\r' ? '\r\n' : '\n';
}
function editNormalizeToLf(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function editRestoreLineEndings(text, ending) {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}
function editNormalizeFuzzy(text) {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}
function editNormalizeCodePoint(value) {
  return value
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}
function editAppendMappedSegment(segment, segmentOffset, output, starts, ends) {
  const units = [];
  for (const grapheme of editGraphemeSegmenter.segment(segment)) {
    const start = segmentOffset + grapheme.index;
    const end = start + grapheme.segment.length;
    const normalized = editNormalizeCodePoint(grapheme.segment);
    for (let i = 0; i < normalized.length; i++) {
      units.push({ value: normalized[i], start, end });
    }
  }
  while (units.length > 0 && /\s/u.test(units[units.length - 1].value)) units.pop();
  for (const unit of units) {
    output.push(unit.value);
    starts.push(unit.start);
    ends.push(unit.end);
  }
}
function editCreateFuzzyView(content) {
  const output = [];
  const starts = [];
  const ends = [];
  let lineStart = 0;
  while (lineStart < content.length) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    editAppendMappedSegment(content.slice(lineStart, lineEnd), lineStart, output, starts, ends);
    if (newline === -1) break;
    output.push('\n');
    starts.push(newline);
    ends.push(newline + 1);
    lineStart = newline + 1;
  }
  return { text: output.join(''), starts, ends };
}
function editCreateLineEndingView(content) {
  const output = [];
  const starts = [];
  const ends = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\r') {
      const end = content[i + 1] === '\n' ? i + 2 : i + 1;
      output.push('\n');
      starts.push(i);
      ends.push(end);
      if (end === i + 2) i++;
      continue;
    }
    output.push(content[i]);
    starts.push(i);
    ends.push(i + 1);
  }
  return { text: output.join(''), starts, ends };
}
function editMapViewRanges(view, ranges) {
  return ranges.map((range) => ({
    start: view.starts[range.start],
    end: view.ends[range.end - 1]
  }));
}
function editFindAllRanges(content, needle) {
  if (needle.length === 0) return [];
  const ranges = [];
  let from = 0;
  while (from <= content.length - needle.length) {
    const start = content.indexOf(needle, from);
    if (start === -1) break;
    ranges.push({ start, end: start + needle.length });
    if (ranges.length > maxEditReplacements) {
      throw new Error('Edit: match count exceeds ' + maxEditReplacements + '; use Write or Shell for a bulk rewrite.');
    }
    from = start + needle.length;
  }
  return ranges;
}
function editFuzzyRanges(view, oldText) {
  const fuzzyOldText = editNormalizeFuzzy(oldText);
  if (fuzzyOldText.length === 0) return [];
  return editFindAllRanges(view.text, fuzzyOldText)
    .filter((range) => {
      const startsInsideMappedUnit = range.start > 0 && view.starts[range.start] === view.starts[range.start - 1];
      const endsInsideMappedUnit = range.end < view.text.length && view.ends[range.end - 1] === view.ends[range.end];
      return !startsInsideMappedUnit && !endsInsideMappedUnit;
    })
    .map((range) => ({
      start: view.starts[range.start],
      end: view.ends[range.end - 1]
    }));
}
function editCollectOperations(request) {
  const operations = [];
  const hasLegacy = request.old_string !== undefined || request.new_string !== undefined;
  if (hasLegacy) {
    if (typeof request.old_string !== 'string' || typeof request.new_string !== 'string') {
      throw new Error('Edit: legacy input requires string old_string and new_string.');
    }
    operations.push({
      old_string: request.old_string,
      new_string: request.new_string,
      replace_all: request.replace_all
    });
  }
  if (Array.isArray(request.edits)) operations.push(...request.edits);
  if (operations.length === 0) throw new Error('Edit: at least one edit is required.');
  return operations;
}
function editApplyOperations(content, operations, relPath) {
  const stripped = editStripBom(content);
  const lineEnding = editDetectLineEnding(stripped.text);
  const lineEndingView = editCreateLineEndingView(stripped.text);
  const fuzzyView = editCreateFuzzyView(lineEndingView.text);
  const planned = [];
  let occurrences = 0;
  let fuzzyMatches = 0;
  operations.forEach((operation, editIndex) => {
    if (!operation || typeof operation.old_string !== 'string' || typeof operation.new_string !== 'string') {
      throw new Error('Edit: edits[' + editIndex + '] requires string old_string and new_string.');
    }
    const oldIncludesBom = operation.old_string.startsWith('\uFEFF');
    const oldText = editNormalizeToLf(oldIncludesBom ? operation.old_string.slice(1) : operation.old_string);
    const newText = editRestoreLineEndings(editNormalizeToLf(operation.new_string), lineEnding);
    const label = operations.length === 1 ? 'old_string' : 'edits[' + editIndex + '].old_string';
    if (oldText.length === 0) throw new Error('Edit: ' + label + ' is empty; use Write for new files.');
    if (oldText === newText) throw new Error('Edit: ' + label + ' equals new_string; no-op.');
    let fuzzy = false;
    let viewRanges = editFindAllRanges(lineEndingView.text, oldText);
    if (viewRanges.length === 0) {
      fuzzy = true;
      viewRanges = editFuzzyRanges(fuzzyView, oldText);
    }
    if (oldIncludesBom) {
      viewRanges = stripped.bom ? viewRanges.filter((range) => range.start === 0) : [];
    }
    if (viewRanges.length === 0) {
      throw new Error('Edit: ' + label + ' not found. It must match including whitespace and newlines; fuzzy quote/space normalization also found no match.');
    }
    if (!operation.replace_all && viewRanges.length > 1) {
      throw new Error('Edit: ' + label + ' matched ' + viewRanges.length + ' times; supply more surrounding context or set replace_all=true.');
    }
    occurrences += viewRanges.length;
    const selectedViewRanges = operation.replace_all ? viewRanges : viewRanges.slice(0, 1);
    const selected = editMapViewRanges(lineEndingView, selectedViewRanges);
    if (planned.length + selected.length > maxEditReplacements) {
      throw new Error('Edit: total replacement count exceeds ' + maxEditReplacements + '; split the operation or use Write/Shell.');
    }
    if (fuzzy) fuzzyMatches += selected.length;
    for (const range of selected) {
      const replacementText = stripped.bom && range.start === 0 && newText.startsWith('\uFEFF')
        ? newText.slice(1)
        : newText;
      planned.push({ editIndex, start: range.start, end: range.end, newText: replacementText });
    }
  });
  planned.sort((a, b) => a.start - b.start || a.end - b.end || a.editIndex - b.editIndex);
  for (let i = 1; i < planned.length; i++) {
    const previous = planned[i - 1];
    const current = planned[i];
    if (previous.end > current.start) {
      throw new Error('Edit: edits[' + previous.editIndex + '] and edits[' + current.editIndex + '] overlap in ' + relPath + '; merge them into one edit or target disjoint regions.');
    }
  }
  const chunks = [];
  let cursor = 0;
  for (const replacement of planned) {
    chunks.push(stripped.text.slice(cursor, replacement.start), replacement.newText);
    cursor = replacement.end;
  }
  chunks.push(stripped.text.slice(cursor));
  const updated = chunks.join('');
  if (updated === stripped.text) {
    throw new Error('Edit: no changes made to ' + relPath + '; the replacement produced identical content.');
  }
  const updatedContent = stripped.bom + updated;
  const updatedBytes = Buffer.byteLength(updatedContent, 'utf8');
  if (updatedBytes > maxEditFileBytes) {
    throw new Error('Edit: result too large (' + updatedBytes + 'B > ' + maxEditFileBytes + 'B); use Write for intentional full-file rewrites.');
  }
  return {
    updatedContent,
    replacements: planned.length,
    occurrences,
    editCount: operations.length,
    fuzzyMatches,
    bomPreserved: stripped.bom.length > 0,
    lineEnding: lineEnding === '\r\n' ? 'CRLF' : 'LF'
  };
}
`;

export const CONTAINER_FILE_HELPER_SCRIPT = `
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const readline = require('readline');
const root = process.env.KY_AGENT_WORKDIR || ${JSON.stringify(DEFAULT_CONTAINER_WORKDIR)};
const maxFileBytes = ${MAX_FILE_BYTES};
const maxReadLines = ${MAX_READ_LINES};
const maxReadOutputBytes = ${MAX_READ_OUTPUT_BYTES};
const maxEditFileBytes = 1000000;
const maxEditReplacements = 10000;
const maxContainerHelperOutputBytes = ${MAX_CONTAINER_HELPER_OUTPUT};
const maxArtifactPayloadBytes = ${MAX_ARTIFACT_PAYLOAD_BYTES};
const maxReadImageSourceBytes = ${MAX_READ_IMAGE_SOURCE_BYTES};
const readImagePayloadMetadataKey = ${JSON.stringify(WORKSPACE_READ_IMAGE_PAYLOAD_METADATA_KEY)};
const editDenyPatterns = [/(^|\\/)\\.ky-agent\\/settings\\.json$/i, /(^|\\/)\\.claude\\/settings\\.json$/i, /(^|\\/)\\.env(\\..+)?$/i, /(^|\\/)\\.npmrc$/i, /(^|\\/)\\.netrc$/i, /(^|\\/)\\.ssh\\//i, /(^|\\/)\\.git\\//i];
function isInside(baseDir, candidate) {
  const rel = path.relative(baseDir, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}
function resolveWorkspacePath(inputPath) {
  const fullPath = path.resolve(root, inputPath || '.');
  if (!isInside(root, fullPath)) {
    throw new Error('Access denied: path outside workspace (' + inputPath + ')');
  }
  return fullPath;
}
function readPathVariants(inputPath) {
  const unicodeSpaces = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
  const variants = new Set();
  const add = (value) => {
    variants.add(value);
    variants.add(value.normalize('NFC'));
    variants.add(value.normalize('NFD'));
    variants.add(value.replace(/'/g, '\u2019'));
    variants.add(value.replace(/\u2019/g, "'"));
    variants.add(value.replace(/ (AM|PM)\\./gi, '\u202F$1.'));
  };
  add(String(inputPath || ''));
  const withoutAtPrefix = String(inputPath || '').startsWith('@') ? String(inputPath).slice(1) : String(inputPath || '');
  add(withoutAtPrefix);
  add(withoutAtPrefix.replace(unicodeSpaces, ' '));
  return [...variants];
}
async function openTrustedParent(fullPath, operation, createParents) {
  const parentPath = path.dirname(fullPath);
  const relParent = path.relative(root, parentPath);
  if (relParent === '..' || relParent.startsWith('..' + path.sep) || path.isAbsolute(relParent)) {
    throw new Error(operation + ': parent escapes workspace');
  }
  const flags = fsSync.constants.O_RDONLY | fsSync.constants.O_DIRECTORY | fsSync.constants.O_NOFOLLOW;
  let current = await fs.open(root, flags);
  try {
    for (const part of relParent.split(path.sep).filter(Boolean)) {
      const candidate = '/proc/self/fd/' + current.fd + '/' + part;
      let next;
      try {
        next = await fs.open(candidate, flags);
      } catch (error) {
        if (!createParents || !error || error.code !== 'ENOENT') {
          if (error && (error.code === 'ELOOP' || error.code === 'ENOTDIR')) {
            throw new Error(operation + ': refused symlink path ' + relativeWorkspacePath(path.join(parentPath, part)));
          }
          throw error;
        }
        await fs.mkdir(candidate).catch((mkdirError) => {
          if (!mkdirError || mkdirError.code !== 'EEXIST') throw mkdirError;
        });
        next = await fs.open(candidate, flags);
      }
      await current.close();
      current = next;
    }
    const parentFdPath = '/proc/self/fd/' + current.fd;
    const openedParent = await fs.realpath(parentFdPath);
    if (!isInside(root, openedParent)) throw new Error(operation + ': opened parent escapes workspace');
    return {
      directory: current,
      leaf: path.basename(fullPath),
      targetPath: path.join(parentFdPath, path.basename(fullPath))
    };
  } catch (error) {
    await current.close().catch(() => undefined);
    throw error;
  }
}
async function openTrustedExistingFile(fullPath, operation) {
  const binding = await openTrustedParent(fullPath, operation, false);
  let handle;
  try {
    handle = await fs.open(binding.targetPath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(operation + ': path is not a file (' + relativeWorkspacePath(fullPath) + ')');
    const openedPath = await fs.realpath('/proc/self/fd/' + handle.fd);
    if (!isInside(root, openedPath)) throw new Error(operation + ': opened file escapes workspace');
    return {
      ...binding,
      handle,
      stats,
      fdPath: '/proc/self/fd/' + handle.fd,
      openedPath,
      relativePath: relativeWorkspacePath(openedPath)
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await binding.directory.close().catch(() => undefined);
    if (error && error.code === 'ELOOP') {
      throw new Error(operation + ': refused symlink path ' + relativeWorkspacePath(fullPath));
    }
    throw error;
  }
}
async function resolveReadPath(inputPath) {
  let exactError;
  for (const variant of readPathVariants(inputPath)) {
    const fullPath = resolveWorkspacePath(variant);
    try {
      return {
        ...(await openTrustedExistingFile(fullPath, 'Read')),
        recovered: variant !== inputPath
      };
    } catch (error) {
      if (!exactError) exactError = error;
      if (error && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  throw exactError || new Error('Read: file not found (' + inputPath + ')');
}
async function assertNoSymlinkPath(fullPath, operation) {
  const relPath = path.relative(root, fullPath);
  let current = root;
  for (const part of relPath.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stats = await fs.lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(operation + ': refused symlink path ' + relativeWorkspacePath(current));
    }
  }
}
function relativeWorkspacePath(fullPath) {
  return path.relative(root, fullPath) || '.';
}
function normalizePath(value) {
  return String(value || '').split(path.sep).join('/');
}
function assertNotDenied(relPath, patterns, message) {
  const normalized = normalizePath(relPath);
  for (const re of patterns) {
    if (re.test('/' + normalized)) throw new Error(message);
  }
}
async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}
async function readFileBufferPrefix(fullPath, maxBytes) {
  const handle = await fs.open(fullPath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const result = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}
async function readFilePrefix(fullPath, maxBytes) {
  return (await readFileBufferPrefix(fullPath, maxBytes)).toString('utf-8');
}
function quoteShellArgument(value) {
  const singleQuote = String.fromCharCode(39);
  const escapedQuote = singleQuote + String.fromCharCode(34) + singleQuote + String.fromCharCode(34) + singleQuote;
  return singleQuote + String(value).split(singleQuote).join(escapedQuote) + singleQuote;
}
async function atomicWriteFile(fullPath, data, expectedFile, expectedContent, existingBinding) {
  const binding = existingBinding || await openTrustedParent(fullPath, 'Write', true);
  const ownsBinding = !existingBinding;
  const directory = binding.directory;
  const targetPath = binding.targetPath;
  let handle;
  let tempPath;
  let published = false;
  try {
    let targetStats;
    try {
      targetStats = await fs.lstat(targetPath);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    if (expectedFile && (
      !targetStats || !targetStats.isFile()
      || targetStats.dev !== expectedFile.dev
      || targetStats.ino !== expectedFile.ino
      || targetStats.size !== expectedFile.size
      || targetStats.mtimeMs !== expectedFile.mtimeMs
      || targetStats.ctimeMs !== expectedFile.ctimeMs
    )) {
      const stale = new Error('Atomic write target changed before commit: ' + relativeWorkspacePath(fullPath));
      stale.code = 'ESTALE';
      throw stale;
    }
    if (expectedContent !== undefined) {
      const current = await fs.open(targetPath, fsSync.constants.O_RDONLY | fsSync.constants.O_NOFOLLOW);
      try {
        const actual = await current.readFile();
        if (!actual.equals(Buffer.from(expectedContent))) {
          const stale = new Error('Atomic write target content changed before commit: ' + relativeWorkspacePath(fullPath));
          stale.code = 'ESTALE';
          throw stale;
        }
      } finally {
        await current.close();
      }
    }
    const mode = targetStats && targetStats.isFile()
      ? targetStats.mode & 0o777
      : (0o664 & ~process.umask());
    const tempLeaf = '.ky-write-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
    tempPath = path.join('/proc/self/fd/' + directory.fd, tempLeaf);
    handle = await fs.open(tempPath, fsSync.constants.O_WRONLY | fsSync.constants.O_CREAT | fsSync.constants.O_EXCL | fsSync.constants.O_NOFOLLOW, mode);
    await handle.writeFile(data);
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, targetPath);
    published = true;
    await directory.sync();
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (tempPath && !published) await fs.unlink(tempPath).catch(() => undefined);
    if (ownsBinding) await directory.close().catch(() => undefined);
  }
}
function detectImageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  const signature = bytes.subarray(0, 6).toString('ascii');
  if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return undefined;
}
async function readLineRange(fullPath, relPath, options) {
  const offset = Math.max(1, Math.trunc(Number(options.offset || 1)));
  const limit = Math.min(maxReadLines, Math.max(1, Math.trunc(Number(options.limit || maxReadLines))));
  const stream = fsSync.createReadStream(fullPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  let lineNo = 0;
  let hasMore = false;
  let returnedBytes = 0;
  let byteLimitReached = false;
  let oversizedLine;
  const contentByteBudget = maxReadOutputBytes - 8 * 1024;
  try {
    for await (const line of rl) {
      lineNo++;
      if (lineNo < offset) continue;
      if (lines.length >= limit) {
        hasMore = true;
        break;
      }
      const separatorBytes = lines.length > 0 ? 1 : 0;
      const remainingBytes = contentByteBudget - returnedBytes - separatorBytes;
      if (remainingBytes <= 0) {
        hasMore = true;
        byteLimitReached = true;
        break;
      }
      const encoded = Buffer.from(line, 'utf8');
      let boundedLine = line;
      if (encoded.length > remainingBytes) {
        boundedLine = encoded.subarray(0, remainingBytes).toString('utf8').replace(/\\uFFFD$/, '');
        oversizedLine = { lineNo, bytes: encoded.length };
        byteLimitReached = true;
        hasMore = true;
      }
      lines.push(boundedLine);
      returnedBytes += separatorBytes + Buffer.byteLength(boundedLine, 'utf8');
      if (byteLimitReached) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (lines.length === 0) {
    return '...[no content: offset ' + offset + ' is beyond EOF for ' + relPath + '; total lines=' + lineNo + ']';
  }
  const endLine = offset + lines.length - 1;
  const suffix = oversizedLine
    ? '\\n...[truncated: line ' + oversizedLine.lineNo + ' is ' + oversizedLine.bytes + ' UTF-8 bytes and exceeds the Read budget; use Shell: sed -n \\'' + oversizedLine.lineNo + 'p\\' -- ' + quoteShellArgument(relPath) + ' | head -c ' + maxReadOutputBytes + ']'
    : byteLimitReached
    ? '\\n...[truncated: Read output reached ' + maxReadOutputBytes + ' UTF-8 bytes while showing ' + relPath + ' lines ' + offset + '-' + endLine + '; narrow the line range or use Search/Shell for targeted inspection]'
    : hasMore
    ? '\\n...[truncated: showing ' + relPath + ' lines ' + offset + '-' + endLine + '; next Read offset=' + (endLine + 1) + ', limit=' + limit + ']'
    : '\\n...[EOF: showing ' + relPath + ' lines ' + offset + '-' + endLine + '; total lines=' + lineNo + ']';
  return lines.join('\\n') + suffix;
}
${CONTAINER_EDIT_HELPER_SCRIPT}
(async () => {
  try {
    const request = JSON.parse(await readStdin() || '{}');
    if (request.op === 'readFile') {
      const resolvedRead = await resolveReadPath(request.path);
      try {
        const stablePath = resolvedRead.fdPath;
        const st = resolvedRead.stats;
        const relPath = resolvedRead.relativePath;
        const recoveredMetadata = resolvedRead.recovered ? { pathRecovered: true } : {};
        const imageMime = detectImageMime(await readFileBufferPrefix(stablePath, 32));
        if (imageMime) {
          if (st.size > maxReadImageSourceBytes) {
            throw new Error('Read: image too large (' + st.size + 'B > ' + maxReadImageSourceBytes + 'B)');
          }
          const data = await fs.readFile(stablePath);
          const payload = {
            sourcePath: relPath,
            fileName: path.basename(resolvedRead.openedPath),
            sizeBytes: data.byteLength,
            dataBase64: data.toString('base64'),
            mimeType: imageMime
          };
          process.stdout.write(JSON.stringify({
            ok: true,
            content: 'Read image ' + relPath + ' (' + imageMime + ', ' + data.byteLength + ' bytes). The image is attached as visual input.',
            metadata: {
              path: relPath,
              fileBytes: st.size,
              mimeType: imageMime,
              [readImagePayloadMetadataKey]: payload,
              ...recoveredMetadata
            }
          }));
          return;
        }
        if (request.offset !== undefined || request.limit !== undefined) {
          process.stdout.write(JSON.stringify({
            ok: true,
            content: await readLineRange(stablePath, relPath, request),
            metadata: { path: relPath, fileBytes: st.size, ranged: true, ...recoveredMetadata }
          }));
          return;
        }
        if (st.size <= maxFileBytes) {
          process.stdout.write(JSON.stringify({
            ok: true,
            content: await readFilePrefix(stablePath, st.size),
            metadata: { path: relPath, fileBytes: st.size, ...recoveredMetadata }
          }));
          return;
        }
        const prefix = await readFilePrefix(stablePath, maxFileBytes);
        process.stdout.write(JSON.stringify({
          ok: true,
          content: prefix + '\\n...[truncated: file ' + relPath + ' is ' + st.size + ' bytes; showing first ' + maxFileBytes + ' bytes. Use Read with {"path":"' + relPath + '","offset":1,"limit":' + maxReadLines + '} to continue by line chunks.]',
          metadata: { path: relPath, fileBytes: st.size, truncated: true, shownBytes: maxFileBytes, ...recoveredMetadata }
        }));
        return;
      } finally {
        await resolvedRead.handle.close().catch(() => undefined);
        await resolvedRead.directory.close().catch(() => undefined);
      }
    }
    if (request.op === 'writeFile') {
      const fullPath = resolveWorkspacePath(request.path);
      await atomicWriteFile(fullPath, String(request.content ?? ''));
      process.stdout.write(JSON.stringify({ ok: true, content: '' }));
      return;
    }
    if (request.op === 'edit') {
      const fullPath = resolveWorkspacePath(request.file_path);
      const requestedRelPath = relativeWorkspacePath(fullPath);
      assertNotDenied(requestedRelPath, editDenyPatterns, 'Edit: path "' + requestedRelPath + '" is in the deny list (sensitive config / credentials). Ask the admin via console if a change is genuinely required.');
      const opened = await openTrustedExistingFile(fullPath, 'Edit');
      const relPath = opened.relativePath;
      try {
        assertNotDenied(relPath, editDenyPatterns, 'Edit: opened path "' + relPath + '" is in the deny list (sensitive config / credentials).');
        const st = opened.stats;
        if (st.size > maxEditFileBytes) throw new Error('Edit: file too large (' + st.size + 'B > ' + maxEditFileBytes + 'B); use Write to rewrite.');
        const content = await opened.handle.readFile('utf-8');
        const applied = editApplyOperations(content, editCollectOperations(request), relPath);
        const updatedBytes = Buffer.from(applied.updatedContent, 'utf8');
        const bytesBefore = Buffer.byteLength(content, 'utf8');
        const bytesAfter = updatedBytes.length;
        const responseJson = JSON.stringify({
          ok: true,
          content: 'Edited ' + relPath + ' (' + applied.replacements + ' replacement' + (applied.replacements === 1 ? '' : 's') + ' across ' + applied.editCount + ' edit' + (applied.editCount === 1 ? '' : 's') + ', ' + bytesAfter + ' bytes).',
          metadata: {
            path: relPath,
            replacements: applied.replacements,
            occurrences: applied.occurrences,
            editCount: applied.editCount,
            fuzzyMatches: applied.fuzzyMatches,
            bomPreserved: applied.bomPreserved,
            lineEnding: applied.lineEnding,
            bytesBefore,
            bytesAfter,
            beforeContent: content,
            afterContent: applied.updatedContent
          }
        });
        const responseBytes = Buffer.byteLength(responseJson, 'utf8');
        if (responseBytes > maxContainerHelperOutputBytes) {
          throw new Error('Edit: prepared helper response too large (' + responseBytes + 'B > ' + maxContainerHelperOutputBytes + 'B).');
        }
        await atomicWriteFile(fullPath, updatedBytes, st, Buffer.from(content, 'utf8'), opened);
        process.stdout.write(responseJson);
        return;
      } finally {
        await opened.handle.close().catch(() => undefined);
        await opened.directory.close().catch(() => undefined);
      }
    }
    if (request.op === 'artifactCreate') {
      const fullPath = resolveWorkspacePath(request.file_path);
      const relPath = relativeWorkspacePath(fullPath);
      assertNotDenied(relPath, editDenyPatterns, 'CreateArtifact: refused sensitive path ' + relPath);
      const lst = await fs.lstat(fullPath);
      if (lst.isSymbolicLink()) throw new Error('CreateArtifact: refused symlink ' + relPath);
      const st = await fs.stat(fullPath);
      if (!st.isFile()) throw new Error('CreateArtifact: source must be a file');
      if (st.size > maxArtifactPayloadBytes) throw new Error('CreateArtifact: file too large (' + st.size + 'B > ' + maxArtifactPayloadBytes + 'B)');
      const data = await fs.readFile(fullPath);
      process.stdout.write(JSON.stringify({
        ok: true,
        content: JSON.stringify({
          sourcePath: normalizePath(relPath),
          fileName: path.basename(fullPath),
          sizeBytes: data.byteLength,
          dataBase64: data.toString('base64'),
          kind: request.kind,
          mimeType: request.mime_type
        })
      }));
      return;
    }
    throw new Error('Unknown container helper op: ' + request.op);
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
  }
})();
`;
