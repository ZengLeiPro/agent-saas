import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  ContainerExecutionProvider,
  ServerLocalExecutionProvider,
  type ExecutionProvider,
  type ExecutionTargetKind,
  type WorkspaceRef,
} from 'server/agent/toolRuntime.js';
import { unknownNetworkPolicyStatus } from 'server/runtime/networkPolicy.js';
import type {
  ToolInvocationRequest,
  ToolInvocationResponse,
} from 'server/runtime/handProtocol.js';

import type { HandServerConfig } from './config.js';
import type { WorkspaceResolver } from './workspaceResolver.js';

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface HandlerDeps {
  config: HandServerConfig;
  invocations?: Map<string, AbortController>;
  workspaceResolver: WorkspaceResolver;
  provider: ExecutionProvider;
  /**
   * Hand 端内部 backend 名（写进 WorkspaceRef.executionTarget）。
   * 注意这跟 brain 侧调用时的 `executionTarget=server-remote` 是不同维度——
   * brain 视角描述 hand 部署位置，hand 内部视角描述实际跑的 backend，
   * audit 字段需要后者作为 provider 标识。
   */
  internalExecutionTarget: ExecutionTargetKind;
  logger: Logger;
}


export function buildHealthResponse(deps: HandlerDeps): Record<string, unknown> {
  const networkPolicy = deps.provider instanceof ContainerExecutionProvider
    ? deps.provider.networkPolicyStatus()
    : unknownNetworkPolicyStatus(
        deps.config.networkPolicy,
        'Local hand backend does not enforce coding-hand networkPolicy. Use container/ACS backends for isolation.',
      );
  return {
    status: 'ok',
    backend: deps.config.backend,
    internalExecutionTarget: deps.internalExecutionTarget,
    networkPolicy,
    container: deps.config.backend === 'container'
      ? {
          image: deps.config.container.image ?? process.env.KY_AGENT_CONTAINER_IMAGE ?? 'node:22-bookworm-slim',
          user: deps.config.container.user ?? 'process uid/gid',
          readOnly: deps.config.container.readOnly ?? true,
          network: 'none',
          networkPolicy,
          capDrop: deps.config.container.capDrop ?? ['ALL'],
          securityOpt: deps.config.container.securityOpt ?? ['no-new-privileges'],
          memory: deps.config.container.memory ?? process.env.KY_AGENT_CONTAINER_MEMORY ?? '1024m',
          cpus: deps.config.container.cpus ?? process.env.KY_AGENT_CONTAINER_CPUS ?? '1.0',
          pidsLimit: deps.config.container.pidsLimit ?? Number.parseInt(process.env.KY_AGENT_CONTAINER_PIDS_LIMIT ?? '256', 10),
        }
      : undefined,
    tools: deps.provider.listInternalTools().map((tool) => tool.name),
  };
}

export function buildToolsResponse(deps: HandlerDeps): Record<string, unknown> {
  return {
    status: 'ok',
    backend: deps.config.backend,
    internalExecutionTarget: deps.internalExecutionTarget,
    tools: deps.provider.listInternalTools().map((tool) => ({
      id: tool.id,
      name: tool.name,
      displayName: tool.displayName,
      description: tool.description,
      risk: tool.risk,
      approvalMode: tool.approvalMode,
      auditCategory: tool.auditCategory,
    })),
  };
}

export function createProvider(config: HandServerConfig): ExecutionProvider {
  const backend = config.backend;
  return backend === 'container'
    ? new ContainerExecutionProvider({
        image: config.container.image,
        dockerPath: config.container.dockerPath,
        user: config.container.user,
        memory: config.container.memory,
        cpus: config.container.cpus,
        pidsLimit: config.container.pidsLimit,
        readOnly: config.container.readOnly,
        tmpfs: config.container.tmpfs,
        capDrop: config.container.capDrop,
        securityOpt: config.container.securityOpt,
        networkPolicy: config.networkPolicy,
      })
    : new ServerLocalExecutionProvider();
}

export function backendToTarget(backend: 'local' | 'container'): ExecutionTargetKind {
  return backend === 'container' ? 'server-container' : 'server-local';
}


/**
 * B3 provisioning step log entry. Mirrored to the brain via the /provision
 * response and persisted there as a `hand_provisioning_log` event so audit
 * can correlate provision failures with brain-side decisions.
 */
export interface ProvisioningLogEntry {
  step: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  status: 'ok' | 'error' | 'skipped';
  note?: string;
}

export interface ParsedRecipe {
  workspaceId: string;
  repo?: { url: string; ref?: string; remote?: string };
  files?: Array<{ artifactId: string; path: string; url?: string; signedUrl?: string }>;
  setupCommands?: string[];
  resources?: { timeoutMs?: number };
}

const SETUP_DEFAULT_TIMEOUT_MS = 60_000;
const SETUP_MAX_OUTPUT_BYTES = 16 * 1024;

/**
 * POST /provision handler. Materializes the workspace dir, then executes recipe
 * setupCommands and returns a structured log of every step. Repo and artifact
 * hydrate are intentionally host-side operations: credentials/signed URLs are
 * consumed by the hand-server process and are never written into setup command
 * text or agent-visible recipe logs.
 */
export async function handleProvision(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  }

  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || match[1] !== deps.config.authToken) {
    deps.logger.warn(`provision auth 失败 from=${req.socket.remoteAddress ?? '-'}`);
    return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  }

  let bodyRaw: string;
  try {
    bodyRaw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    return sendJson(res, 413, {
      status: 'error',
      error: `body 读取失败: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyRaw);
  } catch {
    return sendJson(res, 400, { status: 'error', error: 'body 不是合法 JSON' });
  }

  const recipe = parseProvisionRecipe(body);
  if (!recipe) {
    return sendJson(res, 400, { status: 'error', error: 'workspaceId 必须为非空字符串' });
  }

  const logs: ProvisioningLogEntry[] = [];
  let workspacePath: string;
  const ensureStart = Date.now();
  try {
    workspacePath = await deps.workspaceResolver.resolveAndEnsure(recipe.workspaceId);
    logs.push({
      step: 'workspace_ensure',
      status: 'ok',
      durationMs: Date.now() - ensureStart,
      note: `workspace mounted at ${workspacePath}`,
    });
  } catch (err) {
    logs.push({
      step: 'workspace_ensure',
      status: 'error',
      durationMs: Date.now() - ensureStart,
      stderr: err instanceof Error ? err.message : String(err),
    });
    return sendJson(res, 400, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      logs,
    });
  }

  const recipeHash = hashRecipe(recipe);

  if (recipe.repo) {
    const start = Date.now();
    const result = await hydrateRepo(recipe.repo, workspacePath, clampTimeoutMs(recipe.resources?.timeoutMs));
    logs.push({
      step: 'repo_hydrate',
      command: result.command ? redactProvisioningCommand(result.command) : undefined,
      ...(result.stdout ? { stdout: truncate(result.stdout, SETUP_MAX_OUTPUT_BYTES) } : {}),
      ...(result.stderr ? { stderr: truncate(result.stderr, SETUP_MAX_OUTPUT_BYTES) } : {}),
      exitCode: result.exitCode,
      durationMs: Date.now() - start,
      status: result.exitCode === 0 ? 'ok' : 'error',
      ...(result.note ? { note: result.note } : {}),
    });
    if (result.exitCode !== 0) {
      return sendJson(res, 200, {
        status: 'error',
        error: 'repo hydrate failed; see logs[]',
        workspaceId: recipe.workspaceId,
        backend: deps.config.backend,
        internalExecutionTarget: deps.internalExecutionTarget,
        metadata: { recipeVersion: 1, recipeHash, retryPolicy: defaultRetryPolicy('repo_hydrate') },
        logs,
      });
    }
  }
  if (recipe.files?.length) {
    for (let i = 0; i < recipe.files.length; i++) {
      const file = recipe.files[i]!;
      const start = Date.now();
      const result = await hydrateArtifact(file, workspacePath);
      logs.push({
        step: `artifact_hydrate#${i}`,
        ...(result.stdout ? { stdout: truncate(result.stdout, SETUP_MAX_OUTPUT_BYTES) } : {}),
        ...(result.stderr ? { stderr: truncate(result.stderr, SETUP_MAX_OUTPUT_BYTES) } : {}),
        exitCode: result.exitCode,
        durationMs: Date.now() - start,
        status: result.exitCode === 0 ? 'ok' : 'error',
        note: result.note,
      });
      if (result.exitCode !== 0) {
        return sendJson(res, 200, {
          status: 'error',
          error: 'artifact hydrate failed; see logs[]',
          workspaceId: recipe.workspaceId,
          backend: deps.config.backend,
          internalExecutionTarget: deps.internalExecutionTarget,
          metadata: { recipeVersion: 1, recipeHash, retryPolicy: defaultRetryPolicy('artifact_hydrate') },
          logs,
        });
      }
    }
  }

  const overallTimeoutMs = clampTimeoutMs(recipe.resources?.timeoutMs);
  let sawFailure = false;
  if (recipe.setupCommands?.length) {
    for (let i = 0; i < recipe.setupCommands.length; i++) {
      const command = recipe.setupCommands[i]!;
      const start = Date.now();
      const result = await runSetupCommand(command, workspacePath, overallTimeoutMs);
      logs.push({
        step: `setup_command#${i}`,
        command,
        ...(result.stdout ? { stdout: truncate(result.stdout, SETUP_MAX_OUTPUT_BYTES) } : {}),
        ...(result.stderr ? { stderr: truncate(result.stderr, SETUP_MAX_OUTPUT_BYTES) } : {}),
        exitCode: result.exitCode,
        durationMs: Date.now() - start,
        status: result.exitCode === 0 ? 'ok' : 'error',
        ...(result.timedOut ? { note: `command timed out after ${overallTimeoutMs}ms` } : {}),
      });
      if (result.exitCode !== 0) {
        sawFailure = true;
        break; // stop on first failure — brain can decide whether to retry
      }
    }
  }

  if (sawFailure) {
    return sendJson(res, 200, {
      status: 'error',
      error: 'setup command failed; see logs[]',
      workspaceId: recipe.workspaceId,
      backend: deps.config.backend,
      internalExecutionTarget: deps.internalExecutionTarget,
      metadata: { recipeVersion: 1, recipeHash, retryPolicy: defaultRetryPolicy('setup_command') },
      logs,
    });
  }

  return sendJson(res, 200, {
    status: 'ok',
    workspaceId: recipe.workspaceId,
    backend: deps.config.backend,
    internalExecutionTarget: deps.internalExecutionTarget,
    metadata: { recipeVersion: 1, recipeHash },
    logs,
  });
}

export function parseProvisionRecipe(body: unknown): ParsedRecipe | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  const recipeRaw = obj.recipe && typeof obj.recipe === 'object'
    ? obj.recipe as Record<string, unknown>
    : undefined;
  const workspaceId = obj.workspaceId ?? recipeRaw?.workspaceId;
  const id = typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : null;
  if (!id) return null;
  const parsed: ParsedRecipe = { workspaceId: id };
  const repo = recipeRaw?.repo;
  if (repo && typeof repo === 'object' && typeof (repo as { url?: unknown }).url === 'string') {
    parsed.repo = {
      url: (repo as { url: string }).url,
      ...(typeof (repo as { ref?: unknown }).ref === 'string' ? { ref: (repo as { ref: string }).ref } : {}),
      ...(typeof (repo as { remote?: unknown }).remote === 'string' ? { remote: (repo as { remote: string }).remote } : {}),
    };
  }
  const files = recipeRaw?.files;
  if (Array.isArray(files)) {
    const cleaned: Array<{ artifactId: string; path: string }> = [];
    for (const item of files) {
      if (item && typeof item === 'object'
          && typeof (item as { artifactId?: unknown }).artifactId === 'string'
          && typeof (item as { path?: unknown }).path === 'string') {
        const raw = item as { artifactId: string; path: string; url?: unknown; signedUrl?: unknown };
        cleaned.push({
          artifactId: raw.artifactId,
          path: raw.path,
          ...(typeof raw.url === 'string' ? { url: raw.url } : {}),
          ...(typeof raw.signedUrl === 'string' ? { signedUrl: raw.signedUrl } : {}),
        });
      }
    }
    if (cleaned.length) parsed.files = cleaned;
  }
  const setupCommands = recipeRaw?.setupCommands;
  if (Array.isArray(setupCommands)) {
    const cleaned: string[] = [];
    for (const item of setupCommands) {
      if (typeof item === 'string' && item.trim()) cleaned.push(item);
    }
    if (cleaned.length) parsed.setupCommands = cleaned;
  }
  const resources = recipeRaw?.resources;
  if (resources && typeof resources === 'object') {
    const t = (resources as { timeoutMs?: unknown }).timeoutMs;
    if (typeof t === 'number' && t > 0) parsed.resources = { timeoutMs: t };
  }
  return parsed;
}


interface HydrateResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  command?: string;
  note?: string;
}

function hashRecipe(recipe: ParsedRecipe): string {
  return createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
}

function defaultRetryPolicy(step: string): Record<string, unknown> {
  return { retryable: true, step, maxAttempts: 3, backoffMs: [1000, 5000, 15000] };
}

async function hydrateRepo(repo: NonNullable<ParsedRecipe['repo']>, workspacePath: string, timeoutMs: number): Promise<HydrateResult> {
  const remote = repo.remote?.trim() || 'origin';
  const ref = repo.ref?.trim();
  const entries = await readdir(workspacePath);
  const hasGit = entries.includes('.git');
  let command: string;
  if (hasGit) {
    command = `git remote set-url ${shellQuote(remote)} ${shellQuote(repo.url)} && git fetch --prune ${shellQuote(remote)}${ref ? ` ${shellQuote(ref)}` : ''}${ref ? ` && git checkout --force FETCH_HEAD` : ''}`;
  } else {
    if (entries.length > 0) {
      return { stdout: '', stderr: 'workspace is not empty and is not a git repository', exitCode: 2, note: 'refusing to clone over non-git workspace' };
    }
    command = `git clone ${shellQuote(repo.url)} .${ref ? ` && git checkout --force ${shellQuote(ref)}` : ''}`;
  }
  const result = await runSetupCommand(command, workspacePath, timeoutMs);
  return { ...result, command, note: hasGit ? 'fetched existing repository' : 'cloned repository' };
}

async function hydrateArtifact(file: NonNullable<ParsedRecipe['files']>[number], workspacePath: string): Promise<HydrateResult> {
  const url = file.signedUrl ?? file.url;
  if (!url) return { stdout: '', stderr: 'artifact entry is missing signedUrl/url', exitCode: 2, note: `artifactId=${file.artifactId}` };
  const destination = resolve(workspacePath, file.path);
  if (!destination.startsWith(resolve(workspacePath) + '/')) {
    return { stdout: '', stderr: `artifact path escapes workspace: ${file.path}`, exitCode: 2, note: `artifactId=${file.artifactId}` };
  }
  const response = await fetch(url);
  if (!response.ok) return { stdout: '', stderr: `artifact download HTTP ${response.status}`, exitCode: 1, note: `artifactId=${file.artifactId}` };
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(destination), { recursive: true });
  const tmp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, bytes);
  await rename(tmp, destination).catch(async (err) => { await rm(tmp, { force: true }); throw err; });
  return { stdout: `wrote ${bytes.length} bytes to ${file.path}`, stderr: '', exitCode: 0, note: `artifactId=${file.artifactId}` };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function redactProvisioningCommand(command: string): string {
  return command
    .replace(/https:\/\/([^\s/'\"]+):([^@\s/'\"]+)@/g, 'https://$1:***@')
    .replace(/([?&](?:token|access_token|sig|signature|X-Amz-Signature)=)[^\s'"]+/gi, '$1***');
}

interface SetupRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

async function runSetupCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<SetupRunResult> {
  return await new Promise((resolveResult) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolveResult({
        stdout,
        stderr: stderr + `\n[spawn error] ${err.message}`,
        exitCode: -1,
        timedOut,
      });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolveResult({
        stdout,
        stderr,
        exitCode: timedOut ? 124 : code ?? -1,
        timedOut,
      });
    });
  });
}

function clampTimeoutMs(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) return SETUP_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(1_000, Math.floor(requested)), 600_000);
}

function truncate(value: string, maxBytes: number): string {
  const buf = Buffer.from(value, 'utf-8');
  if (buf.length <= maxBytes) return value;
  return buf.slice(0, maxBytes).toString('utf-8') + `\n…[truncated ${buf.length - maxBytes} bytes]`;
}


/** Shared parser/executor for /execute and /execute-stream. */
async function prepareToolInvocation(
  req: IncomingMessage,
  deps: HandlerDeps,
): Promise<
  | { ok: true; toolRequest: ToolInvocationRequest; invocationId?: string; cleanup: () => void }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  if (req.method !== 'POST') {
    return { ok: false, status: 405, body: { status: 'error', error: 'method not allowed; use POST' } };
  }

  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || match[1] !== deps.config.authToken) {
    deps.logger.warn(`auth 失败 from=${req.socket.remoteAddress ?? '-'}`);
    return { ok: false, status: 401, body: { status: 'error', error: 'unauthorized' } };
  }

  let bodyRaw: string;
  try {
    bodyRaw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    return { ok: false, status: 413, body: { status: 'error', error: `body 读取失败: ${err instanceof Error ? err.message : String(err)}` } };
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyRaw);
  } catch {
    return { ok: false, status: 400, body: { status: 'error', error: 'body 不是合法 JSON' } };
  }

  const parsed = parseWireRequest(body);
  if (!parsed.ok) return { ok: false, status: 400, body: { status: 'error', error: parsed.error } };
  const wire = parsed.value;

  let workspaceRoot: string;
  try {
    workspaceRoot = await deps.workspaceResolver.resolveAndEnsure(wire.context.workspace.id);
  } catch (err) {
    return { ok: false, status: 400, body: { status: 'error', error: err instanceof Error ? err.message : String(err) } };
  }

  const invocationId = wire.context.invocationId;
  if (invocationId && deps.invocations?.has(invocationId)) {
    return { ok: false, status: 409, body: { status: 'error', error: 'invocation already running', invocationId } };
  }
  const controller = invocationId ? registerInvocation(deps, invocationId) : undefined;
  let completed = false;
  const abortOnClose = () => {
    if (!completed) controller?.abort();
  };
  req.on('aborted', abortOnClose);
  req.on('close', abortOnClose);

  const workspace: WorkspaceRef = {
    id: wire.context.workspace.id,
    root: workspaceRoot,
    userId: wire.context.workspace.userId,
    username: wire.context.workspace.username,
    sessionId: wire.context.workspace.sessionId,
    executionTarget: deps.internalExecutionTarget,
  };

  const toolRequest: ToolInvocationRequest = {
    toolName: wire.toolName,
    input: wire.input,
    context: {
      ...(invocationId ? { invocationId } : {}),
      workspace,
      ...(controller ? { signal: controller.signal } : {}),
    },
  };
  return {
    ok: true,
    toolRequest,
    ...(invocationId ? { invocationId } : {}),
    cleanup: () => {
      completed = true;
      req.off('aborted', abortOnClose);
      req.off('close', abortOnClose);
      if (invocationId) deps.invocations?.delete(invocationId);
    },
  };
}

async function executePreparedTool(
  prepared: { toolRequest: ToolInvocationRequest; invocationId?: string; cleanup: () => void },
  deps: HandlerDeps,
): Promise<ToolInvocationResponse> {
  try {
    return await deps.provider.execute(prepared.toolRequest);
  } catch (err) {
    return { status: 'error', error: `hand-server provider.execute throw: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    prepared.cleanup();
  }
}

/**
 * POST /execute handler。
 */
export async function handleExecute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const prepared = await prepareToolInvocation(req, deps);
  if (!prepared.ok) return sendJson(res, prepared.status, prepared.body);
  const response = await executePreparedTool(prepared, deps);
  return sendJson(res, 200, response);
}

export async function handleExecuteStream(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const prepared = await prepareToolInvocation(req, deps);
  if (!prepared.ok) return sendJson(res, prepared.status, prepared.body);

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  let sawCompleted = false;
  let closed = false;
  const markClosed = () => { closed = true; };
  req.on('close', markClosed);
  res.on('close', markClosed);
  const isClosed = () => closed || res.destroyed || res.writableEnded;
  let writeQueue: Promise<boolean> = Promise.resolve(true);
  const waitForDrain = () => new Promise<void>((resolve) => {
    if (isClosed()) { resolve(); return; }
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
    res.once('error', done);
  });
  const writeChunk = async (chunk: unknown) => {
    writeQueue = writeQueue.then(async () => {
      if (isClosed() || (sawCompleted && (!chunk || typeof chunk !== 'object' || (chunk as { type?: unknown }).type !== 'completed'))) return false;
      if (chunk && typeof chunk === 'object' && (chunk as { type?: unknown }).type === 'completed') sawCompleted = true;
      const ok = res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      if (!ok) await waitForDrain();
      return !isClosed();
    });
    return await writeQueue;
  };
  await writeChunk({ type: 'progress', message: 'hand invocation accepted' });
  const heartbeat = setInterval(() => {
    void writeChunk({ type: 'progress', message: 'hand invocation running' }).catch((err) => {
      deps.logger.warn(`stream heartbeat failed invocation=${prepared.invocationId ?? '-'}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, 10_000);
  heartbeat.unref?.();
  try {
    if (deps.provider.executeStream) {
      for await (const chunk of deps.provider.executeStream(prepared.toolRequest)) {
        const written = await writeChunk(chunk);
        if (!written) break;
      }
    } else {
      const response = await executePreparedTool(prepared, deps);
      await writeChunk({ type: 'completed', response });
    }
  } catch (err) {
    await writeChunk({ type: 'completed', response: { status: 'error', error: `hand-server provider.executeStream throw: ${err instanceof Error ? err.message : String(err)}` } });
  } finally {
    clearInterval(heartbeat);
    if (!sawCompleted) await writeChunk({ type: 'completed', response: { status: 'error', error: 'provider stream ended without completed chunk' } });
    req.off('close', markClosed);
    res.off('close', markClosed);
    prepared.cleanup();
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

export async function handleCancelInvocation(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  invocationId: string,
): Promise<void> {
  if (req.method !== 'DELETE') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use DELETE' });
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || match[1] !== deps.config.authToken) return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  const controller = deps.invocations?.get(invocationId);
  if (!controller) return sendJson(res, 200, { status: 'ok', invocationId, cancelled: false, alreadyFinishedOrUnknown: true });
  controller.abort();
  deps.invocations?.delete(invocationId);
  return sendJson(res, 200, { status: 'ok', invocationId, cancelled: true });
}

export async function handleWorkspaceLifecycle(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
  workspaceId: string,
  action: 'archive' | 'reset',
): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { status: 'error', error: 'method not allowed; use POST' });
  const auth = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match || match[1] !== deps.config.authToken) {
    deps.logger.warn(`workspace ${action} auth 失败 from=${req.socket.remoteAddress ?? '-'}`);
    return sendJson(res, 401, { status: 'error', error: 'unauthorized' });
  }

  let reason: string = action;
  try {
    const bodyRaw = await readBody(req, MAX_BODY_BYTES);
    if (bodyRaw.trim()) {
      const body = JSON.parse(bodyRaw) as { reason?: unknown };
      if (typeof body.reason === 'string' && body.reason.trim()) reason = body.reason.trim();
    }
  } catch (err) {
    return sendJson(res, 400, { status: 'error', error: `body 解析失败: ${err instanceof Error ? err.message : String(err)}` });
  }

  try {
    const result = await deps.workspaceResolver.archive(workspaceId, `${action}-${reason}`);
    deps.logger.info(`workspace_${action} workspaceId=${result.workspaceId} archived=${result.archived} archiveId=${result.archiveId ?? '-'} missing=${result.missing === true}`);
    return sendJson(res, 200, {
      status: 'ok',
      action,
      workspaceId: result.workspaceId,
      archived: result.archived,
      missing: result.missing === true,
      ...(result.archiveId ? { archiveId: result.archiveId } : {}),
      note: action === 'reset'
        ? 'workspace archived; next provision will create a fresh workspace directory'
        : 'workspace archived; no files were deleted',
    });
  } catch (err) {
    return sendJson(res, 400, { status: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

function registerInvocation(deps: HandlerDeps, invocationId: string): AbortController {
  const controller = new AbortController();
  deps.invocations?.set(invocationId, controller);
  return controller;
}

interface WireRequest {
  toolName: string;
  input: unknown;
  context: {
    invocationId?: string;
    workspace: {
      id?: string;
      userId?: string;
      username?: string;
      sessionId?: string;
      executionTarget?: string;
    };
  };
}

export function parseWireRequest(body: unknown): { ok: true; value: WireRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body 必须是 object' };
  const b = body as Record<string, unknown>;
  if (typeof b.toolName !== 'string' || !b.toolName) {
    return { ok: false, error: 'toolName 必须为非空字符串' };
  }
  const context = b.context as Record<string, unknown> | undefined;
  const workspace = context?.workspace as Record<string, unknown> | undefined;
  if (!workspace || typeof workspace !== 'object') {
    return { ok: false, error: 'context.workspace 必须是 object' };
  }
  return {
    ok: true,
    value: {
      toolName: b.toolName,
      input: b.input ?? {},
      context: {
        invocationId: typeof context?.invocationId === 'string' ? context.invocationId : undefined,
      workspace: {
          id: typeof workspace.id === 'string' ? workspace.id : undefined,
          userId: typeof workspace.userId === 'string' ? workspace.userId : undefined,
          username: typeof workspace.username === 'string' ? workspace.username : undefined,
          sessionId: typeof workspace.sessionId === 'string' ? workspace.sessionId : undefined,
          executionTarget: typeof workspace.executionTarget === 'string' ? workspace.executionTarget : undefined,
        },
      },
    },
  };
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectBody(new Error(`body 超出上限 ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', rejectBody);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
