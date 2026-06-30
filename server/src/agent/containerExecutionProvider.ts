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
import {
  MAX_ARTIFACT_PAYLOAD_BYTES,
  WORKSPACE_ARTIFACT_PAYLOAD_METADATA_KEY,
} from './workspaceHandTools.js';
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  MAX_FILE_BYTES,
  MAX_LIST_ENTRIES,
  MAX_READ_LINES,
  MAX_SHELL_CAPTURE_BYTES,
  MAX_SHELL_STREAM_BYTES,
  formatShellOutput,
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

const MAX_CONTAINER_HELPER_OUTPUT = Math.ceil(MAX_ARTIFACT_PAYLOAD_BYTES * 1.4) + 64 * 1024;
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
          }, audit);
          return { status: 'success', content: result.content, audit };
        }
        case 'Write': {
          const args = input as { path: string; content: string };
          const relPath = workspaceRelativeInputPath(workspace.root, args.path);
          await this.runNodeHelper(workspace, {
            op: 'writeFile',
            path: relPath,
            content: args.content,
          }, audit);
          return {
            status: 'success',
            content: `wrote ${relPath} (${args.content.length} chars)`,
            audit,
            metadata: { path: relPath, bytesWritten: args.content.length },
          };
        }
        case 'List': {
          const args = input as { path: string; recursive: boolean };
          const result = await this.runNodeHelper(workspace, {
            op: 'listFiles',
            path: workspaceRelativeInputPath(workspace.root, args.path || '.'),
            recursive: args.recursive,
          }, audit);
          return { status: 'success', content: result.content, audit };
        }
        case 'Shell': {
          const args = input as { command: string; timeoutMs?: number };
          const result = await this.runDocker(workspace, ['/bin/sh', '-lc', args.command], {
            operation: 'runShell',
            timeoutMs: args.timeoutMs ?? this.shellTimeoutMs,
            stdoutLimit: MAX_SHELL_CAPTURE_BYTES,
            stderrLimit: MAX_SHELL_CAPTURE_BYTES,
            signal,
            allowNonZeroExit: true,
          }, audit);
          const content = formatShellOutput(result);
          const metadata = {
            exitCode: result.exitCode,
            signal: result.signal,
            stdoutBytes: result.stdoutBytes,
            stderrBytes: result.stderrBytes,
            durationMs: result.durationMs,
          };
          return result.exitCode === 0
            ? { status: 'success', content, audit, metadata }
            : { status: 'error', error: `command exited ${result.exitCode ?? result.signal}\n\n${content}`, audit, metadata };
        }
        case 'Edit': {
          const args = input as { file_path: string; old_string: string; new_string: string; replace_all?: boolean };
          const result = await this.runNodeHelper(workspace, {
            op: 'edit',
            file_path: workspaceRelativeInputPath(workspace.root, args.file_path),
            old_string: args.old_string,
            new_string: args.new_string,
            replace_all: args.replace_all,
          }, audit);
          return { status: 'success', content: result.content, audit };
        }
        case 'Glob': {
          const args = input as { pattern: string; path?: string };
          const result = await this.runNodeHelper(workspace, {
            op: 'glob',
            pattern: args.pattern,
            path: workspaceRelativeInputPath(workspace.root, args.path || '.'),
          }, audit);
          return { status: 'success', content: result.content, audit };
        }
        case 'Grep': {
          const args = input as {
            pattern: string;
            path?: string;
            glob?: string;
            case_insensitive?: boolean;
            max_files?: number;
          };
          const result = await this.runNodeHelper(workspace, {
            op: 'grep',
            pattern: args.pattern,
            path: workspaceRelativeInputPath(workspace.root, args.path || '.'),
            glob: args.glob,
            case_insensitive: args.case_insensitive,
            max_files: args.max_files,
          }, audit);
          return { status: 'success', content: result.content, audit };
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
    this.runDocker(workspace, ['/bin/sh', '-lc', args.command], {
      operation: 'runShell',
      timeoutMs: args.timeoutMs ?? this.shellTimeoutMs,
      stdoutLimit: MAX_SHELL_CAPTURE_BYTES,
      stderrLimit: MAX_SHELL_CAPTURE_BYTES,
      signal,
      allowNonZeroExit: true,
      onOutput: createLimitedStreamForwarder((chunk) => { queue.push(chunk); wake(); }),
    }, audit)
      .then((result) => {
        const content = formatShellOutput(result);
        const metadata = {
          exitCode: result.exitCode,
          signal: result.signal,
          stdoutBytes: result.stdoutBytes,
          stderrBytes: result.stderrBytes,
          durationMs: result.durationMs,
        };
        queue.push({
          type: 'completed',
          response: result.exitCode === 0
            ? { status: 'success', content, audit, metadata }
            : { status: 'error', error: `command exited ${result.exitCode ?? result.signal}\n\n${content}`, audit, metadata },
        });
      })
      .catch((err) => queue.push({ type: 'completed', response: { status: 'error', error: err instanceof Error ? err.message : String(err), audit } }))
      .finally(() => { done = true; wake(); });
    while (!done || queue.length > 0) {
      const chunk = queue.shift();
      if (chunk) { yield chunk; continue; }
      await new Promise<void>((resolve) => { notify = resolve; });
    }
  }

  private async runNodeHelper(
    workspace: WorkspaceRef,
    request: Record<string, unknown> & { op: string },
    audit: ExecutionInvocationAudit[],
    options: { stdoutLimit?: number } = {},
  ): Promise<{ content: string }> {
    const result = await this.runDocker(workspace, ['node', '-e', CONTAINER_FILE_HELPER_SCRIPT], {
      operation: request.op,
      input: JSON.stringify(request),
      timeoutMs: this.fileHelperTimeoutMs,
      stdoutLimit: options.stdoutLimit ?? MAX_FILE_BYTES + 4096,
      stderrLimit: 16 * 1024,
    }, audit);
    let parsed: { ok?: boolean; content?: string; error?: string };
    try {
      parsed = JSON.parse(result.stdout.trim() || '{}') as { ok?: boolean; content?: string; error?: string };
    } catch (err) {
      throw new Error(`Container helper returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!parsed.ok) {
      throw new Error(parsed.error || 'Container helper failed');
    }
    return { content: parsed.content ?? '' };
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
      onOutput?: (channel: 'stdout' | 'stderr', content: string, byteLength: number) => void;
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
    const computedEnv = this.envBuilder ? this.envBuilder(workspace) : this.env;
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
    let outputExceeded = false;
    let spawnError: unknown;

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
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
      void cleanup();
    }, options.timeoutMs);
    timer.unref();

    const abortListener = () => {
      terminate();
      void cleanup();
    };
    options.signal?.addEventListener('abort', abortListener, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.stdoutLimit) {
        outputExceeded = true;
        terminate();
        void cleanup();
        return;
      }
      const text = chunk.toString('utf-8');
      stdout += text;
      options.onOutput?.('stdout', text, chunk.length);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > options.stderrLimit) {
        outputExceeded = true;
        terminate();
        void cleanup();
        return;
      }
      const text = chunk.toString('utf-8');
      stderr += text;
      options.onOutput?.('stderr', text, chunk.length);
    });

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
      options.signal?.removeEventListener('abort', abortListener);
    }

    const error = this.classifyDockerError({
      exit,
      spawnError,
      timedOut,
      outputExceeded,
      aborted: options.signal?.aborted === true,
      stdout,
      stderr,
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
      stdoutBytes,
      stderrBytes,
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
      status: error ? 'error' : 'success',
      ...(timedOut ? { timedOut: true } : {}),
      ...(outputExceeded ? { outputExceeded: true } : {}),
      ...(options.signal?.aborted ? { aborted: true } : {}),
      ...(error ? { error } : {}),
    } satisfies ExecutionInvocationAudit);

    if (error) {
      await cleanup();
      throw new Error(error);
    }
    return {
      stdout,
      stderr,
      stdoutBytes,
      stderrBytes,
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
      durationMs,
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

function createLimitedStreamForwarder(
  push: (chunk: ToolInvocationStreamChunk) => void,
): (channel: 'stdout' | 'stderr', content: string, byteLength: number) => void {
  let streamedBytes = 0;
  let suppressed = false;
  return (channel, content, byteLength) => {
    if (suppressed) return;
    const remainingBytes = MAX_SHELL_STREAM_BYTES - streamedBytes;
    if (remainingBytes <= 0) {
      suppressed = true;
      push({ type: 'progress', message: `Shell stream output truncated after ${MAX_SHELL_STREAM_BYTES} bytes; final result keeps a head/tail summary.` });
      return;
    }
    if (byteLength <= remainingBytes) {
      streamedBytes += byteLength;
      push({ type: 'output', channel, content });
      return;
    }
    streamedBytes = MAX_SHELL_STREAM_BYTES;
    suppressed = true;
    push({ type: 'output', channel, content: content.slice(0, remainingBytes) });
    push({ type: 'progress', message: `Shell stream output truncated after ${MAX_SHELL_STREAM_BYTES} bytes; final result keeps a head/tail summary.` });
  };
}

const CONTAINER_FILE_HELPER_SCRIPT = `
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const readline = require('readline');
const root = process.env.KY_AGENT_WORKDIR || ${JSON.stringify(DEFAULT_CONTAINER_WORKDIR)};
const maxFileBytes = ${MAX_FILE_BYTES};
const maxListEntries = ${MAX_LIST_ENTRIES};
const maxReadLines = ${MAX_READ_LINES};
const maxEditFileBytes = 1000000;
const maxGlobPaths = 5000;
const maxGlobDepth = 12;
const maxGrepFiles = 200;
const maxGrepMatchesPerFile = 200;
const maxGrepFileBytes = 5 * 1024 * 1024;
const maxGrepPatternLength = 256;
const maxGrepTotalWallMs = 5000;
const maxArtifactPayloadBytes = ${MAX_ARTIFACT_PAYLOAD_BYTES};
const globSkipDirs = new Set(['node_modules', '.git', '.venv', '.cache', '.next', 'dist', 'build', 'out', 'target', 'coverage', '.turbo', '.parcel-cache', '.runtime-events', '.browser-profile', '.ky-agent']);
const globSkipFilePatterns = [/\\.env(\\..+)?$/i, /\\.(npmrc|netrc|pypirc)$/i, /\\.(pem|key|crt|p12|pfx)$/i];
const binaryExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf', '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.mp3', '.mp4', '.m4a', '.mov', '.avi', '.mkv', '.webm', '.exe', '.bin', '.so', '.dylib', '.dll', '.class', '.jar', '.woff', '.woff2', '.ttf', '.otf']);
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
function segmentToRegex(seg) {
  let i = 0;
  let out = '';
  while (i < seg.length) {
    const ch = seg[i];
    if (ch === '*') {
      out += '[^/]*';
      i++;
    } else if (ch === '?') {
      out += '[^/]';
      i++;
    } else if (ch === '[') {
      const close = seg.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\\\[';
        i++;
      } else {
        let body = seg.slice(i + 1, close);
        if (body.startsWith('!')) body = '^' + body.slice(1);
        body = body.replace(/\\\\/g, '\\\\\\\\').replace(/\\]/g, '\\\\]');
        out += '[' + body + ']';
        i = close + 1;
      }
    } else if ('.+()|^$\\\\{}'.includes(ch)) {
      out += '\\\\' + ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
function globToRegExp(patternValue) {
  const segs = String(patternValue || '').split('/');
  const re = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '**') {
      if (i === 0) {
        re.push('(?:.*/)?');
      } else if (i === segs.length - 1) {
        re[re.length - 1] = re[re.length - 1].replace(/\\/$/, '(?:/.*)?');
      } else {
        re.push('(?:.*/)?');
      }
      continue;
    }
    re.push(segmentToRegex(seg));
    if (i < segs.length - 1) re[re.length - 1] += '/';
  }
  return new RegExp('^' + re.join('') + '$');
}
async function walkWorkspace(baseDir, opts) {
  const options = opts || { maxPaths: maxGlobPaths, maxDepth: maxGlobDepth };
  const results = [];
  async function walk(current, depth) {
    if (results.length >= options.maxPaths || depth > options.maxDepth) return;
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= options.maxPaths) break;
      if (globSkipDirs.has(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        if (globSkipFilePatterns.some((re) => re.test(entry.name))) continue;
        try {
          const st = await fs.lstat(full);
          if (st.isSymbolicLink()) continue;
          results.push({ path: relativeWorkspacePath(full), mtimeMs: st.mtimeMs });
        } catch {}
      }
    }
  }
  await walk(baseDir, 0);
  return results;
}
async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}
async function readFilePrefix(fullPath, maxBytes) {
  const handle = await fs.open(fullPath, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    const result = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.toString('utf-8', 0, result.bytesRead);
  } finally {
    await handle.close();
  }
}
async function readLineRange(fullPath, relPath, options) {
  const offset = Math.max(1, Math.trunc(Number(options.offset || 1)));
  const limit = Math.min(maxReadLines, Math.max(1, Math.trunc(Number(options.limit || maxReadLines))));
  const stream = fsSync.createReadStream(fullPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  let lineNo = 0;
  let hasMore = false;
  try {
    for await (const line of rl) {
      lineNo++;
      if (lineNo < offset) continue;
      if (lines.length >= limit) {
        hasMore = true;
        break;
      }
      lines.push(line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (lines.length === 0) {
    return '...[no content: offset ' + offset + ' is beyond EOF for ' + relPath + '; total lines=' + lineNo + ']';
  }
  const endLine = offset + lines.length - 1;
  const suffix = hasMore
    ? '\\n...[truncated: showing ' + relPath + ' lines ' + offset + '-' + endLine + '; next Read offset=' + (endLine + 1) + ', limit=' + limit + ']'
    : '\\n...[EOF: showing ' + relPath + ' lines ' + offset + '-' + endLine + '; total lines=' + lineNo + ']';
  return lines.join('\\n') + suffix;
}
(async () => {
  try {
    const request = JSON.parse(await readStdin() || '{}');
    if (request.op === 'readFile') {
      const fullPath = resolveWorkspacePath(request.path);
      const st = await fs.stat(fullPath);
      if (!st.isFile()) throw new Error('Read: path is not a file (' + request.path + ')');
      const relPath = relativeWorkspacePath(fullPath);
      if (request.offset !== undefined || request.limit !== undefined) {
        process.stdout.write(JSON.stringify({ ok: true, content: await readLineRange(fullPath, relPath, request) }));
        return;
      }
      if (st.size <= maxFileBytes) {
        process.stdout.write(JSON.stringify({ ok: true, content: await readFilePrefix(fullPath, st.size) }));
        return;
      }
      const prefix = await readFilePrefix(fullPath, maxFileBytes);
      process.stdout.write(JSON.stringify({ ok: true, content: prefix + '\\n...[truncated: file ' + relPath + ' is ' + st.size + ' bytes; showing first ' + maxFileBytes + ' bytes. Use Read with {"path":"' + relPath + '","offset":1,"limit":' + maxReadLines + '} to continue by line chunks.]' }));
      return;
    }
    if (request.op === 'writeFile') {
      const fullPath = resolveWorkspacePath(request.path);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, String(request.content ?? ''), 'utf-8');
      process.stdout.write(JSON.stringify({ ok: true, content: '' }));
      return;
    }
    if (request.op === 'listFiles') {
      const start = resolveWorkspacePath(request.path || '.');
      const results = [];
      async function walk(current) {
        if (results.length >= maxListEntries) return;
        const entries = await fs.readdir(current, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          const full = path.resolve(current, entry.name);
          results.push((entry.isDirectory() ? 'dir ' : 'file ') + relativeWorkspacePath(full));
          if (request.recursive && entry.isDirectory()) await walk(full);
          if (results.length >= maxListEntries) break;
        }
      }
      await walk(start);
      const suffix = results.length >= maxListEntries ? '\\n...[truncated at ' + maxListEntries + ' entries]' : '';
      process.stdout.write(JSON.stringify({ ok: true, content: results.join('\\n') + suffix }));
      return;
    }
    if (request.op === 'edit') {
      const fullPath = resolveWorkspacePath(request.file_path);
      const relPath = relativeWorkspacePath(fullPath);
      assertNotDenied(relPath, editDenyPatterns, 'Edit: path "' + relPath + '" is in the deny list (sensitive config / credentials). Ask the admin via console if a change is genuinely required.');
      let st;
      try {
        st = await fs.stat(fullPath);
      } catch (err) {
        throw new Error('Edit: cannot stat ' + relPath + ' (' + (err && err.message ? err.message : String(err)) + ')');
      }
      if (st.size > maxEditFileBytes) throw new Error('Edit: file too large (' + st.size + 'B > ' + maxEditFileBytes + 'B); use Write to rewrite.');
      let content;
      try {
        content = await fs.readFile(fullPath, 'utf-8');
      } catch (err) {
        throw new Error('Edit: cannot read ' + relPath + ' (' + (err && err.message ? err.message : String(err)) + ')');
      }
      const oldString = String(request.old_string ?? '');
      const newString = String(request.new_string ?? '');
      if (oldString === newString) throw new Error('Edit: old_string equals new_string; no-op.');
      if (oldString === '') throw new Error('Edit: empty old_string not allowed; use Write for new files.');
      const parts = content.split(oldString);
      const occurrences = parts.length - 1;
      if (occurrences === 0) throw new Error('Edit: old_string not found.');
      if (!request.replace_all && occurrences > 1) throw new Error('Edit: old_string matched ' + occurrences + ' times; supply more surrounding context or set replace_all=true.');
      const updated = parts.join(newString);
      const replacements = request.replace_all ? occurrences : 1;
      await fs.writeFile(fullPath, updated, 'utf-8');
      process.stdout.write(JSON.stringify({ ok: true, content: 'Edited ' + relPath + ' (' + replacements + ' replacement' + (replacements === 1 ? '' : 's') + ', ' + updated.length + ' bytes).' }));
      return;
    }
    if (request.op === 'glob') {
      const baseDir = resolveWorkspacePath(request.path || '.');
      const regex = globToRegExp(request.pattern);
      const all = await walkWorkspace(baseDir);
      const matched = all.filter((entry) => regex.test(normalizePath(entry.path))).sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (matched.length === 0) {
        process.stdout.write(JSON.stringify({ ok: true, content: '（无匹配项；扫描 ' + all.length + ' 文件）' }));
        return;
      }
      const lines = matched.slice(0, maxGlobPaths).map((entry) => entry.path);
      const suffix = matched.length >= maxGlobPaths ? '\\n...[truncated at ' + maxGlobPaths + ' paths]' : '';
      process.stdout.write(JSON.stringify({ ok: true, content: lines.join('\\n') + suffix }));
      return;
    }
    if (request.op === 'grep') {
      if (String(request.pattern || '').length > maxGrepPatternLength) throw new Error('Grep: pattern too long');
      const baseDir = resolveWorkspacePath(request.path || '.');
      const flags = request.case_insensitive ? 'gi' : 'g';
      let regex;
      try {
        regex = new RegExp(String(request.pattern), flags);
      } catch (err) {
        throw new Error('Grep: bad regex (' + (err && err.message ? err.message : String(err)) + ')');
      }
      const globRegex = request.glob ? globToRegExp(request.glob) : null;
      const all = await walkWorkspace(baseDir, { maxPaths: maxGrepFiles * 4, maxDepth: maxGlobDepth });
      const candidates = globRegex ? all.filter((entry) => globRegex.test(normalizePath(entry.path))) : all;
      const limit = request.max_files || maxGrepFiles;
      const files = candidates.slice(0, limit);
      const matches = [];
      let totalMatches = 0;
      let timeBudgetHit = false;
      let binarySkipped = 0;
      let oversizeSkipped = 0;
      const deadline = Date.now() + maxGrepTotalWallMs;
      for (const file of files) {
        if (Date.now() > deadline) {
          timeBudgetHit = true;
          break;
        }
        const ext = path.extname(file.path).toLowerCase();
        if (binaryExt.has(ext)) {
          binarySkipped++;
          continue;
        }
        const fullPath = resolveWorkspacePath(file.path);
        let st;
        try {
          st = await fs.stat(fullPath);
        } catch {
          continue;
        }
        if (st.size > maxGrepFileBytes) {
          oversizeSkipped++;
          continue;
        }
        let body;
        try {
          body = await fs.readFile(fullPath, 'utf-8');
        } catch {
          continue;
        }
        if (body.indexOf('\\0') >= 0) {
          binarySkipped++;
          continue;
        }
        const lines = body.split('\\n');
        let fileMatchCount = 0;
        for (let lineNo = 0; lineNo < lines.length; lineNo++) {
          if (fileMatchCount >= maxGrepMatchesPerFile) break;
          if (Date.now() > deadline) {
            timeBudgetHit = true;
            break;
          }
          regex.lastIndex = 0;
          if (regex.test(lines[lineNo])) {
            matches.push(file.path + ':' + (lineNo + 1) + ':' + lines[lineNo]);
            fileMatchCount++;
            totalMatches++;
          }
        }
        if (timeBudgetHit) break;
      }
      const summaryParts = ['[matched ' + totalMatches + ' line(s) across ' + files.length + ' file(s); cap=' + limit];
      if (binarySkipped) summaryParts.push('binarySkipped=' + binarySkipped);
      if (oversizeSkipped) summaryParts.push('oversizeSkipped=' + oversizeSkipped);
      if (timeBudgetHit) summaryParts.push('time-budget-hit (' + maxGrepTotalWallMs + 'ms)');
      summaryParts.push(']');
      const summary = summaryParts.join('; ');
      const content = matches.length === 0 ? '（无匹配） ' + summary : matches.join('\\n') + '\\n\\n' + summary;
      process.stdout.write(JSON.stringify({ ok: true, content }));
      return;
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
