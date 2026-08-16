import type { WorkspaceRef } from 'server/agent/toolRuntime.js';
import { ServerLocalExecutionProvider } from 'server/agent/toolRuntime.js';
import {
  MAX_SHELL_RETURN_CHARS,
  truncateMiddle,
} from 'server/agent/toolOutput.js';
import type {
  ToolInvocationResponse,
  ToolInvocationStreamChunk,
} from 'server/runtime/handProtocol.js';

import {
  prepareSnapshotExecution,
  type SnapshotExecutionLease,
  type SnapshotExecutionMetadata,
} from './snapshotExecution.js';

const MAX_VALIDATION_COMMANDS = 8;
export const MAX_VALIDATION_CONCURRENCY = 4;

const VALIDATION_SCRIPTS = new Set([
  'test',
  'typecheck',
  'type-check',
  'build',
  'check',
  'check:ratchets',
  'lint',
  'validate',
  'verify',
]);
const MUTATING_OR_INTERACTIVE_FLAGS = new Set([
  '--fix',
  '--write',
  '--watch',
  '--watchall',
  '--update',
  '--updatesnapshot',
  '--prune',
  '-u',
]);

export interface SnapshotValidationChainPlan {
  commands: string[];
  maxConcurrency: number;
}

interface ValidationLaneResult {
  command: string;
  response: ToolInvocationResponse;
  snapshot?: SnapshotExecutionMetadata;
}

export function planSnapshotValidationChain(command: string): SnapshotValidationChainPlan | undefined {
  const commands = splitTopLevelAndChain(command);
  if (!commands || commands.length < 2 || commands.length > MAX_VALIDATION_COMMANDS) return undefined;
  if (!commands.every(isKnownValidationCommand)) return undefined;
  return {
    commands,
    maxConcurrency: Math.min(MAX_VALIDATION_CONCURRENCY, commands.length),
  };
}

export async function executeSnapshotValidationChain(input: {
  plan: SnapshotValidationChainPlan;
  workspaceRoot: string;
  cwd?: string;
  timeoutMs?: number;
  env: Record<string, string>;
  signal: AbortSignal;
  invocationId?: string;
  workspace: Omit<WorkspaceRef, 'root' | 'executionTarget'>;
  stream: boolean;
  emit: (chunk: ToolInvocationStreamChunk) => void;
}): Promise<ToolInvocationResponse> {
  const startedAt = Date.now();
  if (input.stream) {
    input.emit({
      type: 'progress',
      message: `检测到 ${input.plan.commands.length} 段独立验证命令，正在容器临时盘最多 ${input.plan.maxConcurrency} 路并行执行`,
    });
  }
  const results = await mapWithConcurrency(
    input.plan.commands,
    input.plan.maxConcurrency,
    async (command, index) => await executeValidationLane({ ...input, command, index }),
  );
  return buildValidationChainResponse(results, Date.now() - startedAt, input.plan.maxConcurrency);
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index]!, index);
    }
  }));
  return results;
}

async function executeValidationLane(input: {
  command: string;
  index: number;
  plan: SnapshotValidationChainPlan;
  workspaceRoot: string;
  cwd?: string;
  timeoutMs?: number;
  env: Record<string, string>;
  signal: AbortSignal;
  invocationId?: string;
  workspace: Omit<WorkspaceRef, 'root' | 'executionTarget'>;
  stream: boolean;
  emit: (chunk: ToolInvocationStreamChunk) => void;
}): Promise<ValidationLaneResult> {
  const label = `验证 ${input.index + 1}/${input.plan.commands.length}`;
  let lease: SnapshotExecutionLease | undefined;
  try {
    if (input.signal.aborted) throw new Error('Shell aborted');
    lease = await prepareSnapshotExecution({
      workspaceRoot: input.workspaceRoot,
      command: input.command,
      cwd: input.cwd,
      signal: input.signal,
      env: input.env,
      progress: input.stream
        ? (message) => input.emit({ type: 'progress', message: `${label}：${message}` })
        : undefined,
    });
    const workspace: WorkspaceRef = {
      ...input.workspace,
      root: lease.root,
      executionTarget: 'server-local',
    };
    const provider = new ServerLocalExecutionProvider({ envBuilder: () => lease!.env });
    let response: ToolInvocationResponse | undefined;
    for await (const chunk of provider.executeStream({
      toolName: 'Shell',
      input: {
        command: input.command,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      },
      context: {
        ...(input.invocationId ? { invocationId: `${input.invocationId}-validation-${input.index + 1}` } : {}),
        workspace,
        signal: input.signal,
      },
    })) {
      if (chunk.type === 'completed') {
        response = chunk.response;
      } else if (input.stream && chunk.type === 'output') {
        input.emit({ ...chunk, content: `[${label} ${chunk.channel}]\n${chunk.content}` });
      } else if (input.stream && chunk.type === 'progress') {
        input.emit({ ...chunk, message: `${label}：${chunk.message}` });
      }
    }
    return {
      command: input.command,
      response: response ?? { status: 'error', error: `${label} 未返回终态结果` },
      snapshot: lease.metadata,
    };
  } catch (err) {
    return {
      command: input.command,
      response: { status: 'error', error: err instanceof Error ? err.message : String(err) },
      ...(lease ? { snapshot: lease.metadata } : {}),
    };
  } finally {
    await lease?.cleanup().catch(() => undefined);
  }
}

function buildValidationChainResponse(
  results: ValidationLaneResult[],
  durationMs: number,
  maxConcurrency: number,
): ToolInvocationResponse {
  const failed = results.filter((result) => result.response.status === 'error');
  const metadataRows = results.map((result) => ({
    command: result.command,
    status: result.response.status,
    preparationMs: result.snapshot?.preparationMs,
    commandMs: numericMetadata(result.response, 'durationMs'),
    totalMs: result.snapshot && numericMetadata(result.response, 'durationMs') !== undefined
      ? result.snapshot.preparationMs + numericMetadata(result.response, 'durationMs')!
      : undefined,
    dependencyCacheHit: result.snapshot?.dependencyCacheHit,
    exitCode: numericMetadata(result.response, 'exitCode'),
    timedOut: result.response.metadata?.timedOut === true,
  }));
  const outputFiles = results.flatMap((result) => Array.isArray(result.response.metadata?.outputFiles)
    ? result.response.metadata.outputFiles
    : []);
  const firstSnapshot = results.find((result) => result.snapshot)?.snapshot;
  const firstFailure = failed[0]?.response;
  const dependencyCacheFacts = results
    .map((result) => result.snapshot?.dependencyCacheHit)
    .filter((value): value is boolean => value !== undefined);
  const metadata = {
    executionRequested: 'snapshot',
    executionUsed: 'snapshot',
    durationMs,
    executionTotalMs: durationMs,
    exitCode: firstFailure ? (numericMetadata(firstFailure, 'exitCode') ?? 1) : 0,
    timedOut: failed.some((result) => result.response.metadata?.timedOut === true),
    stdoutBytes: sumMetadata(results, 'stdoutBytes'),
    stderrBytes: sumMetadata(results, 'stderrBytes'),
    snapshotPreparationMs: maxSnapshotMetadata(results, 'preparationMs'),
    snapshotMaterializationMs: maxSnapshotMetadata(results, 'snapshotMs'),
    snapshotDependencyMs: maxSnapshotMetadata(results, 'dependencyMs'),
    ...(dependencyCacheFacts.length > 0
      ? { snapshotDependencyCacheHit: dependencyCacheFacts.every(Boolean) }
      : {}),
    validationChainSplit: true,
    validationChainCommandCount: results.length,
    validationChainMaxConcurrency: maxConcurrency,
    validationChain: metadataRows,
    ...(firstSnapshot?.sourceRevision ? { snapshotSourceRevision: firstSnapshot.sourceRevision } : {}),
    ...(firstSnapshot?.repositoryPath ? { snapshotRepositoryPath: firstSnapshot.repositoryPath } : {}),
    ...(firstSnapshot?.sourceCwd ? { snapshotSourceCwd: firstSnapshot.sourceCwd } : {}),
    ...(firstSnapshot?.dirtyFileCount !== undefined ? { snapshotDirtyFileCount: firstSnapshot.dirtyFileCount } : {}),
    ...(outputFiles.length > 0 ? { outputFiles } : {}),
  };
  const body = renderValidationResults(results);
  const note = `[执行位置] 容器临时盘快照；验证链 ${results.length} 段、最多 ${maxConcurrency} 路并行；总耗时 ${durationMs}ms`;
  if (failed.length === 0) {
    return {
      status: 'success',
      content: `${body}\n\n${note}`,
      metadata,
    };
  }
  return {
    status: 'error',
    error: `${failed.length}/${results.length} 段验证失败\n\n${body}\n\n${note}`,
    metadata,
  };
}

function renderValidationResults(results: ValidationLaneResult[]): string {
  const overhead = results.reduce((sum, result, index) => (
    sum + result.command.length + String(index + 1).length + 40
  ), 0);
  const perResult = Math.max(2_048, Math.floor((MAX_SHELL_RETURN_CHARS - overhead) / results.length));
  return results.map((result, index) => {
    const payload = result.response.status === 'success' ? result.response.content : result.response.error;
    const status = result.response.status === 'success' ? '成功' : '失败';
    return `=== 验证 ${index + 1}/${results.length} · ${status} ===\n$ ${result.command}\n${truncateMiddle(payload, perResult).text}`;
  }).join('\n\n');
}

function sumMetadata(results: ValidationLaneResult[], key: string): number {
  return results.reduce((sum, result) => sum + (numericMetadata(result.response, key) ?? 0), 0);
}

function maxSnapshotMetadata(
  results: ValidationLaneResult[],
  key: 'preparationMs' | 'snapshotMs' | 'dependencyMs',
): number {
  return Math.max(0, ...results.map((result) => result.snapshot?.[key] ?? 0));
}

function numericMetadata(response: ToolInvocationResponse, key: string): number | undefined {
  const value = response.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function splitTopLevelAndChain(command: string): string[] | undefined {
  const segments: string[] = [];
  let start = 0;
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === 'single') {
      if (char === "'") quote = undefined;
      continue;
    }
    if (quote === 'double') {
      if (char === '\\') escaped = true;
      else if (char === '"') quote = undefined;
      else if (char === '`' || (char === '$' && command[index + 1] === '(')) return undefined;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === "'") {
      quote = 'single';
      continue;
    }
    if (char === '"') {
      quote = 'double';
      continue;
    }
    if (char === '`' || (char === '$' && command[index + 1] === '(')) return undefined;
    if (char === '&' && command[index + 1] === '&') {
      const segment = command.slice(start, index).trim();
      if (!segment) return undefined;
      segments.push(segment);
      index += 1;
      start = index + 1;
      continue;
    }
    if (char === '&' || char === '|' || char === ';' || char === '<' || char === '>' || char === '\n' || char === '\r') {
      return undefined;
    }
  }
  if (quote || escaped) return undefined;
  const finalSegment = command.slice(start).trim();
  if (!finalSegment) return undefined;
  segments.push(finalSegment);
  return segments;
}

function isKnownValidationCommand(command: string): boolean {
  const words = shellWords(command);
  if (words.length === 0 || words.some(isMutatingOrInteractiveFlag)) return false;
  let index = 0;
  if (words[index] === 'corepack') index += 1;
  const manager = words[index];
  if (manager === 'pnpm' || manager === 'npm') {
    return isPackageManagerValidation(words.slice(index), manager);
  }
  if (manager === 'npx') {
    return isDirectValidationTool(words.slice(index + 1));
  }
  if (manager === 'node') return words[index + 1] === '--test';
  return isDirectValidationTool(words.slice(index));
}

function isPackageManagerValidation(words: string[], manager: 'pnpm' | 'npm'): boolean {
  let index = 1;
  const optionsWithValue = manager === 'pnpm'
    ? new Set(['--dir', '--filter', '--global-dir', '--store-dir', '-C', '-F'])
    : new Set(['--prefix', '--workspace', '-w']);
  while (index < words.length) {
    const word = words[index]!;
    if (optionsWithValue.has(word)) {
      index += 2;
      continue;
    }
    if (word.startsWith('--filter=') || word.startsWith('--dir=') || word.startsWith('--workspace=')) {
      index += 1;
      continue;
    }
    if (word.startsWith('-')) {
      index += 1;
      continue;
    }
    break;
  }
  const subcommand = words[index];
  if (!subcommand) return false;
  if (subcommand === 'exec' || subcommand === 'dlx') return isDirectValidationTool(words.slice(index + 1));
  const script = subcommand === 'run' || subcommand === 'run-script' ? words[index + 1] : subcommand;
  if (typeof script !== 'string') return false;
  return VALIDATION_SCRIPTS.has(script.toLowerCase()) || isDirectValidationTool(words.slice(index));
}

function isDirectValidationTool(words: string[]): boolean {
  let index = 0;
  while (words[index]?.startsWith('-')) index += 1;
  const tool = words[index]?.split('/').pop()?.toLowerCase();
  if (!tool) return false;
  if (tool === 'prettier') return words.slice(index + 1).includes('--check');
  if (tool === 'vitest') return words.slice(index + 1).some((word) => word === 'run' || word === '--run');
  if (tool === 'vite') return words[index + 1] === 'build';
  if (tool === 'turbo') {
    const task = words.slice(index + 1).find((word) => !word.startsWith('-'));
    return Boolean(task && VALIDATION_SCRIPTS.has(task.toLowerCase()));
  }
  return new Set(['jest', 'tsc', 'eslint']).has(tool);
}

function isMutatingOrInteractiveFlag(word: string): boolean {
  const normalized = word.toLowerCase().split('=')[0]!;
  return MUTATING_OR_INTERACTIVE_FLAGS.has(normalized);
}

function shellWords(command: string): string[] {
  return [...command.matchAll(/"(?:\\.|[^"])*"|'[^']*'|\\.|[^\s]+/g)]
    .map((match) => match[0]!.replace(/^(?:"|')|(?:"|')$/g, ''));
}
