import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { ExecutionTargetKind } from 'server/agent/toolRuntime.js';

import type { Logger } from './handlers.js';
import { MAX_BODY_BYTES, readBody, sendJson, truncate } from './httpSupport.js';

/**
 * POST /provision：幂等准备 workspace（供 brain/registry 重建 hand 时调用）。
 * TASK-316 从 handlers.ts 原样拆出，行为不变；handlers.ts re-export 保持既有 import 兼容。
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

export interface ProvisionHandlerDeps {
  config: { authToken: string; backend: 'local' | 'container' };
  /** 兼容旧测试构造：provision 本身不使用 provider，但 HandlerDeps 携带它整体传入。 */
  provider?: unknown;
  workspaceResolver: { resolveAndEnsure(workspaceId: string): Promise<string> };
  internalExecutionTarget: ExecutionTargetKind;
  logger: Logger;
}

const SETUP_DEFAULT_TIMEOUT_MS = 60_000;
const SETUP_MAX_OUTPUT_BYTES = 16 * 1024;

export async function handleProvision(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ProvisionHandlerDeps,
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
    const result = await hydrateRepo(
      recipe.repo,
      workspacePath,
      clampTimeoutMs(recipe.resources?.timeoutMs),
    );
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
          metadata: {
            recipeVersion: 1,
            recipeHash,
            retryPolicy: defaultRetryPolicy('artifact_hydrate'),
          },
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
        break; // stop on first failure - brain can decide whether to retry
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
  const recipeRaw =
    obj.recipe && typeof obj.recipe === 'object'
      ? (obj.recipe as Record<string, unknown>)
      : undefined;
  const workspaceId = obj.workspaceId ?? recipeRaw?.workspaceId;
  const id = typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : null;
  if (!id) return null;
  const parsed: ParsedRecipe = { workspaceId: id };
  const repo = recipeRaw?.repo;
  if (repo && typeof repo === 'object' && typeof (repo as { url?: unknown }).url === 'string') {
    parsed.repo = {
      url: (repo as { url: string }).url,
      ...(typeof (repo as { ref?: unknown }).ref === 'string'
        ? { ref: (repo as { ref: string }).ref }
        : {}),
      ...(typeof (repo as { remote?: unknown }).remote === 'string'
        ? { remote: (repo as { remote: string }).remote }
        : {}),
    };
  }
  const files = recipeRaw?.files;
  if (Array.isArray(files)) {
    const cleaned: Array<{ artifactId: string; path: string }> = [];
    for (const item of files) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { artifactId?: unknown }).artifactId === 'string' &&
        typeof (item as { path?: unknown }).path === 'string'
      ) {
        const raw = item as {
          artifactId: string;
          path: string;
          url?: unknown;
          signedUrl?: unknown;
        };
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

async function hydrateRepo(
  repo: NonNullable<ParsedRecipe['repo']>,
  workspacePath: string,
  timeoutMs: number,
): Promise<HydrateResult> {
  const remote = repo.remote?.trim() || 'origin';
  const ref = repo.ref?.trim();
  const entries = await readdir(workspacePath);
  const hasGit = entries.includes('.git');
  let command: string;
  if (hasGit) {
    command = `git remote set-url ${shellQuote(remote)} ${shellQuote(repo.url)} && git fetch --prune ${shellQuote(remote)}${ref ? ` ${shellQuote(ref)}` : ''}${ref ? ` && git checkout --force FETCH_HEAD` : ''}`;
  } else {
    if (entries.length > 0) {
      return {
        stdout: '',
        stderr: 'workspace is not empty and is not a git repository',
        exitCode: 2,
        note: 'refusing to clone over non-git workspace',
      };
    }
    command = `git clone ${shellQuote(repo.url)} .${ref ? ` && git checkout --force ${shellQuote(ref)}` : ''}`;
  }
  const result = await runSetupCommand(command, workspacePath, timeoutMs);
  return { ...result, command, note: hasGit ? 'fetched existing repository' : 'cloned repository' };
}

async function hydrateArtifact(
  file: NonNullable<ParsedRecipe['files']>[number],
  workspacePath: string,
): Promise<HydrateResult> {
  const url = file.signedUrl ?? file.url;
  if (!url)
    return {
      stdout: '',
      stderr: 'artifact entry is missing signedUrl/url',
      exitCode: 2,
      note: `artifactId=${file.artifactId}`,
    };
  const destination = resolve(workspacePath, file.path);
  if (!destination.startsWith(resolve(workspacePath) + '/')) {
    return {
      stdout: '',
      stderr: `artifact path escapes workspace: ${file.path}`,
      exitCode: 2,
      note: `artifactId=${file.artifactId}`,
    };
  }
  const response = await fetch(url);
  if (!response.ok)
    return {
      stdout: '',
      stderr: `artifact download HTTP ${response.status}`,
      exitCode: 1,
      note: `artifactId=${file.artifactId}`,
    };
  const bytes = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(destination), { recursive: true });
  const tmp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, bytes);
  await rename(tmp, destination).catch(async (err) => {
    await rm(tmp, { force: true });
    throw err;
  });
  return {
    stdout: `wrote ${bytes.length} bytes to ${file.path}`,
    stderr: '',
    exitCode: 0,
    note: `artifactId=${file.artifactId}`,
  };
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
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2_000).unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
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
        exitCode: timedOut ? 124 : (code ?? -1),
        timedOut,
      });
    });
  });
}

function clampTimeoutMs(requested: number | undefined): number {
  if (!requested || !Number.isFinite(requested) || requested <= 0) return SETUP_DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(1_000, Math.floor(requested)), 600_000);
}
