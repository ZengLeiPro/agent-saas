import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import type { AcsOrchestratorConfig } from './config.js';
import { Kubectl } from './kubectl.js';
import type {
  SandboxRunnerFinalOutput,
  SandboxRunnerInput,
  SandboxRunnerOutput,
  WireToolInvocationRequest,
} from './protocol.js';
import type { ActiveSandboxRegistry } from './activeSandboxRegistry.js';
import { PersistentSandboxRunner } from './persistentRunner.js';
import type { SandboxManager, SandboxRef, SandboxResourceOverride } from './sandboxManager.js';
import type { ToolInvocationResponse, ToolInvocationStreamChunk } from 'server/runtime/handProtocol.js';
import { sandboxResourceOverride } from './provision.js';
import { summarizeRunnerStderr } from './runnerLog.js';
import {
  ACTIVE_INVOCATION_LEASE_MS,
  InvocationLeaseMonitor,
} from './invocationLeaseMonitor.js';

interface InvocationEntry {
  controller: AbortController;
  child?: ChildProcessWithoutNullStreams;
  sandboxName?: string;
}

interface InvocationProtectionState {
  preserveInvocationLease: boolean;
}

interface AcsExecutorOptions {
  persistentRunner?: boolean;
  terminateBackgroundTasks?: (ref: SandboxRef, taskIds: string[]) => Promise<void>;
}

export class AcsExecutor {
  private readonly invocations = new Map<string, InvocationEntry>();
  private readonly persistentRunners = new Map<string, PersistentSandboxRunner>();
  private readonly persistentRunnerPromises = new Map<string, Promise<PersistentSandboxRunner>>();
  private readonly ensureRunningAt = new Map<string, number>();
  private readonly ensureRunningPromises = new Map<string, Promise<void>>();
  private readonly persistentRunnerBackoffUntil = new Map<string, number>();
  private invocationSeq = 0;

  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly kubectl: Kubectl,
    private readonly sandboxManager: SandboxManager,
    private readonly logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void },
    private readonly activeRegistry?: ActiveSandboxRegistry,
    private readonly options: AcsExecutorOptions = {},
  ) {}

  async execute(request: WireToolInvocationRequest): Promise<ToolInvocationResponse> {
    let final = null as ToolInvocationResponse | null;
    for await (const chunk of this.executeStream(request, { stream: false })) {
      if (chunk.type === 'completed') final = chunk.response;
    }
    return final ?? { status: 'error', error: 'ACS sandbox runner ended without completed chunk' };
  }

  async *executeStream(
    request: WireToolInvocationRequest,
    options: { stream: boolean; signal?: AbortSignal },
  ): AsyncIterable<ToolInvocationStreamChunk> {
    const workspace = request.context.workspace;
    const resourceOverride = workspace.sandboxResources
      ? sandboxResourceOverride({ workspaceId: workspace.id!, resources: workspace.sandboxResources }, this.config)
      : undefined;
    const sandboxIdentity = {
      workspaceId: workspace.id!,
      sessionId: workspace.sessionId!,
      sandboxScopeId: workspace.sandboxScopeId,
      mountSubPath: workspace.mountSubPath,
      ...(resourceOverride ? { resources: resourceOverride } : {}),
      ...(workspace.workload ? { workload: workspace.workload } : {}),
    };
    const ref = this.sandboxManager.ref(sandboxIdentity);
    const invocationId = request.context.invocationId;
    const invocationKey = invocationId ?? `internal-${Date.now()}-${++this.invocationSeq}`;
    // 同一 invocationId 可因跨实例重试并发存在；每次执行必须使用独立 annotation key，
    // 否则旧实例 finally 清理会删除新实例刚续租的 lease。
    const leaseKey = `${invocationKey}:${randomUUID()}`;
    if (this.invocations.has(invocationKey)) {
      yield {
        type: 'completed',
        response: { status: 'error', error: `ACS invocation already running: ${invocationKey}` },
      };
      return;
    }
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    this.invocations.set(invocationKey, { controller, sandboxName: ref.name });
    const releaseActive = this.activeRegistry?.acquire(ref.name, invocationKey);
    let leasePersisted = false;
    let leaseMonitor: InvocationLeaseMonitor | undefined;
    let finalResponse: ToolInvocationResponse | undefined;
    let runError: unknown;
    const protectionState: InvocationProtectionState = { preserveInvocationLease: false };
    const failForLease = (error: Error) => { // Runner termination is part of the lease fence.
      this.logger.error(
        `invocation_lease_lost sandbox=${ref.name} invocation=${invocationKey}: ${error.message}`,
      );
      controller.abort();
      this.invocations.get(invocationKey)?.child?.kill('SIGTERM');
      const persistent = this.persistentRunners.get(ref.name);
      if (persistent) {
        persistent.close('invocation_lease_lost');
        this.persistentRunners.delete(ref.name);
      }
    };
    try {
      await this.ensureSandboxRunning(ref, sandboxIdentity, invocationKey);
      const leaseUntilMs = Date.now() + ACTIVE_INVOCATION_LEASE_MS;
      await this.sandboxManager.setActiveInvocationLease(
        ref.name,
        leaseKey,
        new Date(leaseUntilMs).toISOString(),
      );
      leasePersisted = true;
      leaseMonitor = new InvocationLeaseMonitor(
        (leaseUntil) => this.sandboxManager.setActiveInvocationLease(ref.name, leaseKey, leaseUntil),
        failForLease,
      );
      leaseMonitor.start(leaseUntilMs);
      if (leaseMonitor.failure) throw leaseMonitor.failure;
      if (controller.signal.aborted) return;
      // 把 wire.context.env（parseWireRequest 已 allowlist 过滤过）透传给
      // pod 内 sandboxRunner，让其合并进 spawn 子进程的 env，pod 里 Shell 才能
      // 拿到 AZEROTH_TOKEN 等凭据。env 为空则不写字段（wire 更紧凑，与协议一致）。
      const wireEnv = request.context.env;
      const runnerCorrelation = request.context.correlation
        ? { ...request.context.correlation, sandboxId: ref.name }
        : undefined;
      const runnerInput: SandboxRunnerInput = {
        toolName: toolNameForSandboxRunner(request.toolName),
        input: request.input,
        invocationId,
        ...(runnerCorrelation ? { correlation: runnerCorrelation } : {}),
        workspace: {
          id: workspace.id,
          userId: workspace.userId,
          username: workspace.username,
          sessionId: workspace.sessionId,
          root: this.config.workspaceMountPath,
        },
        stream: options.stream,
        ...(wireEnv && Object.keys(wireEnv).length > 0 ? { env: wireEnv } : {}),
      };
      let runner: PersistentSandboxRunner | undefined;
      if (
        this.options.persistentRunner !== false
        && Date.now() >= (this.persistentRunnerBackoffUntil.get(ref.name) ?? 0)
      ) {
        try {
          runner = await this.getPersistentRunner(ref);
        } catch (err) {
          this.persistentRunnerBackoffUntil.set(ref.name, Date.now() + 5 * 60_000);
          this.logger.warn(`runner_daemon_fallback sandbox=${ref.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (controller.signal.aborted) {
        if (leaseMonitor.failure) throw leaseMonitor.failure;
        return;
      }
      if (runner) {
        yield { type: 'progress', message: 'acs sandbox invocation accepted' };
        for await (const output of runner.invoke(invocationKey, runnerInput, controller.signal)) {
          if (output.kind === 'chunk') {
            if (output.chunk.type === 'completed') {
              finalResponse = addRunnerMetadata(output.chunk.response, 'persistent');
              await this.applyBackgroundShellProtection(ref, finalResponse, leaseKey, protectionState);
            } else if (!leaseMonitor?.failure) {
              yield output.chunk;
            }
          } else {
            finalResponse = addRunnerMetadata(output.response, 'persistent');
            await this.applyBackgroundShellProtection(ref, finalResponse, leaseKey, protectionState);
          }
        }
      } else {
        for await (const output of this.executeOneShot(
          ref, runnerInput, controller, invocationKey, leaseKey, protectionState,
        )) {
          if (output.type === 'completed') finalResponse = output.response;
          else if (!leaseMonitor?.failure) yield output;
        }
      }
    } catch (err) {
      runError = err;
    } finally {
      const leaseFailure = await leaseMonitor?.finish();
      options.signal?.removeEventListener('abort', onExternalAbort);
      this.invocations.delete(invocationKey);
      releaseActive?.();
      if (leasePersisted && !leaseFailure && !protectionState.preserveInvocationLease) {
        try {
          await this.sandboxManager.setActiveInvocationLease(ref.name, leaseKey);
        } catch (err) {
          this.logger.warn(`invocation_lease_clear_failed sandbox=${ref.name} invocation=${invocationKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
        try {
          await this.sandboxManager.touch(ref.name);
        } catch (err) {
          // Lease/touch cleanup is lifecycle bookkeeping. Never replace a completed tool result.
          this.logger.warn(`invocation_touch_failed sandbox=${ref.name} invocation=${invocationKey}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (leaseFailure) {
        finalResponse = {
          status: 'error',
          error: `ACS invocation aborted because persisted lease was lost: ${leaseFailure.message}`,
        };
        runError = undefined;
      }
    }
    if (runError) throw runError;
    if (finalResponse) yield { type: 'completed', response: finalResponse };
  }

  cancel(invocationId: string): boolean {
    const entry = this.invocations.get(invocationId);
    if (!entry) return false;
    entry.controller.abort();
    entry.child?.kill('SIGTERM');
    if (entry.sandboxName) this.persistentRunners.get(entry.sandboxName)?.cancel(invocationId);
    return true;
  }

  busySandboxNames(): Set<string> {
    return new Set(
      [...this.invocations.values()]
        .map((entry) => entry.sandboxName)
        .filter((name): name is string => Boolean(name)),
    );
  }

  async reconcileBackgroundShellProtections(): Promise<{ checked: number; failed: number }> {
    const sandboxes = (await this.sandboxManager.listManagedSandboxes())
      .filter((sandbox) => Boolean(
        sandbox.backgroundShellProtectedUntil || sandbox.activeInvocationLeaseUntil,
      ));
    let failed = 0;
    for (const sandbox of sandboxes) {
      if (!sandbox.workspaceId || !sandbox.sessionId) {
        failed += 1;
        continue;
      }
      const response = await this.execute({
        toolName: '__BackgroundShellReconcile',
        input: {},
        context: {
          workspace: {
            id: sandbox.workspaceId,
            sessionId: sandbox.sessionId,
            sandboxScopeId: sandbox.sandboxScopeId,
            mountSubPath: sandbox.mountSubPath,
          },
        },
      }).catch((err) => ({
        status: 'error' as const,
        error: err instanceof Error ? err.message : String(err),
      }));
      if (response.status === 'error') {
        failed += 1;
        this.logger.warn(`background_shell_reconcile_failed sandbox=${sandbox.name}: ${response.error}`);
      }
    }
    return { checked: sandboxes.length, failed };
  }

  /** Persist workspace protection or terminate every active task before releasing the invocation lease. */
  private async applyBackgroundShellProtection(
    ref: SandboxRef,
    response: ToolInvocationResponse,
    leaseKey: string,
    state: InvocationProtectionState,
  ): Promise<void> {
    const raw = response.metadata?.backgroundShell;
    if (!raw || typeof raw !== 'object') return;
    const sandboxName = ref.name;
    const background = raw as {
      taskId?: unknown;
      status?: unknown;
      protectedUntil?: unknown;
      activeTaskIds?: unknown;
    };
    const protectedUntil = typeof background.protectedUntil === 'string' ? background.protectedUntil : undefined;
    const protectedUntilMs = protectedUntil ? Date.parse(protectedUntil) : Number.NaN;
    const activeTaskIds = Array.isArray(background.activeTaskIds)
      ? background.activeTaskIds.filter((taskId): taskId is string => typeof taskId === 'string')
      : [];
    const currentTaskActive = typeof background.taskId === 'string'
      && typeof background.status === 'string'
      && !['completed', 'failed', 'cancelled', 'timed_out', 'lost'].includes(background.status);
    const protectedTaskIds = activeTaskIds.length > 0
      ? [...new Set(activeTaskIds)]
      : currentTaskActive ? [background.taskId as string] : [];
    const aggregateProtectionActive = protectedTaskIds.length > 0
      || (Number.isFinite(protectedUntilMs) && protectedUntilMs > Date.now());
    if (aggregateProtectionActive) state.preserveInvocationLease = true;
    if (protectedTaskIds.length > 0 && !(Number.isFinite(protectedUntilMs) && protectedUntilMs > Date.now())) {
      await this.failClosedBackgroundTasks(ref, protectedTaskIds, state, 'missing aggregate protection deadline');
    }
    try {
      await this.sandboxManager.setBackgroundShellProtection(sandboxName, protectedUntil);
      if (aggregateProtectionActive) state.preserveInvocationLease = false;
    } catch (protectionError) {
      if (!aggregateProtectionActive) throw protectionError;
      try {
        await this.sandboxManager.setActiveInvocationLease(sandboxName, leaseKey, protectedUntil);
        this.logger.warn(
          `background_shell_protection_fallback sandbox=${sandboxName} task=${String(background.taskId ?? protectedTaskIds[0])}`,
        );
      } catch (leaseError) {
        await this.failClosedBackgroundTasks(
          ref,
          protectedTaskIds,
          state,
          `protection=${errorMessage(protectionError)} lease=${errorMessage(leaseError)}`,
        );
      }
    }
  }

  private async failClosedBackgroundTasks(
    ref: SandboxRef,
    taskIds: string[],
    state: InvocationProtectionState,
    reason: string,
  ): Promise<never> {
    const terminate = this.options.terminateBackgroundTasks
      ?? ((targetRef: SandboxRef, ids: string[]) => this.terminateBackgroundTasks(targetRef, ids));
    try {
      // The runner reconciles the whole workspace even when an older response did
      // not include activeTaskIds, then proves that no background process remains.
      await terminate(ref, taskIds);
    } catch (terminationError) {
      throw new Error(
        `后台 Shell 保护持久化失败且终止任务失败，保留现有 invocation lease: ${reason} termination=${errorMessage(terminationError)}`,
      );
    }
    // No background process remains, so the short invocation lease can be cleared.
    state.preserveInvocationLease = false;
    throw new Error(`后台 Shell 保护持久化失败，已终止活跃任务: ${reason}`);
  }

  private async terminateBackgroundTasks(ref: SandboxRef, taskIds: string[]): Promise<void> {
    const response = await this.invokeDirectRunner(ref, {
      toolName: '__BackgroundShellFailClosed',
      input: { task_ids: taskIds },
      workspace: {
        id: ref.workspaceId,
        sessionId: ref.sessionId,
        root: this.config.workspaceMountPath,
      },
      stream: false,
    });
    if (response.status === 'error') throw new Error(response.error);
    const remaining = (response.metadata?.backgroundShell as { activeTaskIds?: unknown } | undefined)?.activeTaskIds;
    if (!Array.isArray(remaining) || remaining.some((taskId) => typeof taskId !== 'string') || remaining.length > 0) {
      throw new Error('后台任务终止后未得到空 activeTaskIds 确认');
    }
  }

  private async invokeDirectRunner(ref: SandboxRef, input: SandboxRunnerInput): Promise<ToolInvocationResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(30_000, this.config.execTimeoutMs));
    timer.unref?.();
    try {
      const invocationKey = `internal-background-fail-closed-${randomUUID()}`;
      const existing = this.persistentRunners.get(ref.name);
      if (existing?.isHealthy()) {
        let final: ToolInvocationResponse | undefined;
        for await (const output of existing.invoke(invocationKey, input, controller.signal)) {
          if (output.kind === 'final') final = output.response;
          else if (output.chunk.type === 'completed') final = output.chunk.response;
        }
        if (final) return final;
      }
      const child = this.spawnRunner(ref, input, controller);
      const closePromise = waitForClose(child);
      let final: ToolInvocationResponse | undefined;
      for await (const line of readLines(child)) {
        const parsed = parseRunnerLine(line);
        if (parsed?.kind === 'final') final = parsed.response;
        else if (parsed?.kind === 'chunk' && parsed.chunk.type === 'completed') final = parsed.chunk.response;
      }
      await closePromise;
      return final ?? { status: 'error', error: '后台任务终止 runner 未返回结果' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSandboxRunning(
    ref: SandboxRef,
    identity: {
      workspaceId: string;
      sessionId: string;
      sandboxScopeId?: string;
      mountSubPath?: string;
      resources?: SandboxResourceOverride;
      workload?: import('./sandboxLifecyclePolicy.js').SandboxWorkloadDescriptor;
    },
    invocationKey: string,
  ): Promise<void> {
    const existingRunner = this.persistentRunners.get(ref.name);
    const resourceKey = JSON.stringify(ref.resources ?? null);
    const ensureKey = `${ref.name}:${resourceKey}`;
    const lastEnsure = this.ensureRunningAt.get(ensureKey) ?? 0;
    if (existingRunner?.isHealthy() && Date.now() - lastEnsure < 60_000) return;
    const pending = this.ensureRunningPromises.get(ensureKey);
    if (pending) return await pending;
    const ensure = this.sandboxManager.ensureRunning(identity, {
      busySandboxNames: this.busySandboxNames(),
      activeKey: invocationKey,
    }).then((result) => {
      if (result.resourceDriftDeferred) this.ensureRunningAt.delete(ensureKey);
      else this.ensureRunningAt.set(ensureKey, Date.now());
    }).finally(() => {
      this.ensureRunningPromises.delete(ensureKey);
    });
    this.ensureRunningPromises.set(ensureKey, ensure);
    await ensure;
  }

  private async getPersistentRunner(ref: SandboxRef): Promise<PersistentSandboxRunner> {
    const existing = this.persistentRunners.get(ref.name);
    if (existing?.isHealthy()) return existing;
    const pending = this.persistentRunnerPromises.get(ref.name);
    if (pending) return await pending;
    existing?.close('runner_replaced');
    this.persistentRunners.delete(ref.name);
    const connect = this.connectPersistentRunner(ref).finally(() => {
      this.persistentRunnerPromises.delete(ref.name);
    });
    this.persistentRunnerPromises.set(ref.name, connect);
    return await connect;
  }

  private async connectPersistentRunner(ref: SandboxRef): Promise<PersistentSandboxRunner> {
    const runner = new PersistentSandboxRunner(this.config, this.kubectl, ref, this.logger);
    try {
      await runner.start();
      this.persistentRunners.set(ref.name, runner);
      this.persistentRunnerBackoffUntil.delete(ref.name);
      return runner;
    } catch (err) {
      runner.close('runner_start_failed');
      throw err;
    }
  }

  private async *executeOneShot(
    ref: SandboxRef,
    runnerInput: SandboxRunnerInput,
    controller: AbortController,
    invocationKey: string,
    leaseKey: string,
    protectionState: InvocationProtectionState,
  ): AsyncIterable<ToolInvocationStreamChunk> {
    const child = this.spawnRunner(ref, runnerInput, controller);
    const closePromise = waitForClose(child);
    this.invocations.set(invocationKey, { controller, child, sandboxName: ref.name });
    yield { type: 'progress', message: 'acs sandbox invocation accepted' };
    // Protection persistence shares the parent invocation lease fallback state.
    let sawCompleted = false;
    for await (const line of readLines(child)) {
      const parsed = parseRunnerLine(line);
      if (!parsed) continue;
      if (parsed.kind === 'chunk') {
        if (parsed.chunk.type === 'completed') {
          sawCompleted = true;
          const response = addRunnerMetadata(parsed.chunk.response, 'one-shot');
          await this.applyBackgroundShellProtection(ref, response, leaseKey, protectionState);
          yield { ...parsed.chunk, response };
          continue;
        }
        yield parsed.chunk;
      } else {
        sawCompleted = true;
        const response = addRunnerMetadata(parsed.response, 'one-shot');
        await this.applyBackgroundShellProtection(ref, response, leaseKey, protectionState);
        yield { type: 'completed', response };
      }
    }
    const exit = await closePromise;
    if (!sawCompleted) {
      yield {
        type: 'completed',
        response: {
          status: 'error',
          error: `ACS sandbox runner exited without final response (code=${exit.exitCode ?? exit.signal ?? 'unknown'})`,
        },
      };
    }
  }

  private spawnRunner(ref: SandboxRef, input: SandboxRunnerInput, controller: AbortController): ChildProcessWithoutNullStreams {
    const args = [
      'exec',
      '-i',
      ref.name,
      '-c',
      this.config.sandboxContainerName,
      '--',
      // 2026-08-10（A 方案批次 3）：优先跑镜像内预编译的单文件 ESM。
      // pod 内实测 tsx 实时转译 480~730ms vs 预编译 68ms（快 7~9 倍），
      // 这是每一次工具调用都要付的固定底噪。
      //
      // 用 sh -c 做运行期存在性判断而非直接指向 .mjs：蓝绿/回滚期间可能短暂
      // 跑到不含该产物的旧镜像，此时静默退回 tsx 保持可用（宁可慢，不可不可用）。
      // 镜像构建侧已对产物做 fail-fast 校验，正常路径不会走到 fallback。
      '/bin/sh',
      '-c',
      'if [ -s /app/acs-orchestrator/dist/sandboxRunner.mjs ]; then '
      + 'exec node /app/acs-orchestrator/dist/sandboxRunner.mjs; '
      + 'else '
      + 'exec /app/acs-orchestrator/node_modules/.bin/tsx /app/acs-orchestrator/src/sandboxRunner.ts; '
      + 'fi',
    ];
    const child = this.kubectl.spawn(args, {
      input: JSON.stringify(input),
      signal: controller.signal,
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim();
      if (text) this.logger.warn(`kubectl_exec_stderr sandbox=${ref.name} ${summarizeRunnerStderr(text)}`);
    });
    return child;
  }
}

export function toolNameForSandboxRunner(toolName: string): string {
  switch (toolName) {
    case 'Read':
      return 'read_file';
    case 'Write':
      return 'write_file';
    case 'Shell':
      return 'run_shell';
    default:
      return toolName;
  }
}

async function* readLines(child: ChildProcessWithoutNullStreams): AsyncIterable<string> {
  let buffer = '';
  for await (const chunk of child.stdout) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      if (part.trim()) yield part;
    }
  }
  if (buffer.trim()) yield buffer;
}

async function waitForClose(child: ChildProcessWithoutNullStreams): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolve) => {
    child.on('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function parseRunnerLine(line: string): SandboxRunnerOutput | SandboxRunnerFinalOutput | null {
  try {
    const parsed = JSON.parse(line) as SandboxRunnerOutput | SandboxRunnerFinalOutput;
    if (parsed && typeof parsed === 'object' && (parsed.kind === 'chunk' || parsed.kind === 'final')) return parsed;
    return null;
  } catch {
    return {
      kind: 'chunk',
      chunk: { type: 'output', channel: 'stdout', content: `${line}\n` },
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addRunnerMetadata(
  response: ToolInvocationResponse,
  mode: 'persistent' | 'one-shot',
): ToolInvocationResponse {
  return { ...response, metadata: { ...(response.metadata ?? {}), acsRunner: { mode } } };
}
