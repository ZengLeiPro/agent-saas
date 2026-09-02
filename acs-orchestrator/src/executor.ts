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
import { MAX_BACKGROUND_SHELL_TIMEOUT_MS } from './backgroundShell.js';
import { summarizeRunnerStderr } from './runnerLog.js';
import {
  ACTIVE_INVOCATION_LEASE_MS,
  InvocationLeaseMonitor,
} from './invocationLeaseMonitor.js';
import { establishInvocationCompletionFence, recoverInvocationCompletion } from './invocationCompletionRecovery.js';

interface InvocationEntry {
  controller: AbortController;
  child?: ChildProcessWithoutNullStreams;
  sandboxName?: string;
}

interface InvocationProtectionState {
  preserveInvocationLease: boolean;
  backgroundMetadataObserved?: boolean;
  observedBackgroundProtectionGeneration?: string | null;
  originalSandboxGone?: boolean;
  recovery?: {
    expectedUid: string;
    protectedUntil?: string;
    taskIds: string[];
    reason: string;
  };
}

interface AcsExecutorOptions {
  persistentRunner?: boolean;
  terminateBackgroundTasks?: (ref: SandboxRef, taskIds: string[]) => Promise<void>;
  reconcileBackgroundTasks?: (ref: SandboxRef) => Promise<{ protectedUntil?: string; activeTaskIds: string[] }>;
  backgroundRecoveryRetryMs?: number;
}

const BACKGROUND_PROTECTION_CONFIRM_MARGIN_MS = 5_000;
const UNKNOWN_BACKGROUND_SHELL_PROTECTION_MS = 2 * MAX_BACKGROUND_SHELL_TIMEOUT_MS;

export class AcsExecutor {
  private readonly invocations = new Map<string, InvocationEntry>();
  private readonly persistentRunners = new Map<string, PersistentSandboxRunner>();
  private readonly persistentRunnerPromises = new Map<string, Promise<PersistentSandboxRunner>>();
  private readonly ensureRunningAt = new Map<string, number>();
  private readonly ensureRunningPromises = new Map<string, Promise<void>>();
  private readonly persistentRunnerBackoffUntil = new Map<string, number>();
  private readonly backgroundProtectionRecoveries = new Set<Promise<void>>();
  private readonly invocationCompletionRecoveries = new Set<Promise<void>>();
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
    const backgroundShellRequested = isBackgroundShellRequest(request);
    const requestedTaskId = (request.input as Record<string, unknown>)?.taskId;
    const ownedBackgroundTaskId = backgroundShellRequested && typeof requestedTaskId === 'string' ? requestedTaskId : undefined;
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
    let sandboxUid: string | undefined;
    let leaseMonitor: InvocationLeaseMonitor | undefined;
    let recoveryOwnsLease = false;
    let finalResponse: ToolInvocationResponse | undefined;
    let runError: unknown;
    const protectionState: InvocationProtectionState = { preserveInvocationLease: false };
    const failForLease = (error: Error) => { // Runner termination is part of the lease fence.
      this.logger.error(
        `invocation_lease_lost sandbox=${ref.name} invocation=${invocationKey}: ${error.message}`,
      );
      if (recoveryOwnsLease) return;
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
      sandboxUid = await this.sandboxManager.setActiveInvocationLease(
        ref.name, leaseKey, new Date(leaseUntilMs).toISOString(), undefined, leaseKey,
      );
      if (!sandboxUid) throw new Error('invocation lease mutation did not return Sandbox UID');
      leasePersisted = true;
      if (typeof this.sandboxManager.getBackgroundShellProtection === 'function') {
        const observed = await this.sandboxManager.getBackgroundShellProtection(ref.name, sandboxUid);
        protectionState.observedBackgroundProtectionGeneration = observed.generation;
      }
      leaseMonitor = new InvocationLeaseMonitor(
        async (leaseUntil) => {
          await this.sandboxManager.setActiveInvocationLease(
            ref.name, leaseKey, leaseUntil, sandboxUid,
          );
        },
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
              await this.applyBackgroundShellProtection(
                ref, finalResponse, leaseKey, sandboxUid, protectionState, ownedBackgroundTaskId,
              );
            } else if (!leaseMonitor?.failure) {
              yield output.chunk;
            }
          } else {
            finalResponse = addRunnerMetadata(output.response, 'persistent');
            await this.applyBackgroundShellProtection(
              ref, finalResponse, leaseKey, sandboxUid, protectionState, ownedBackgroundTaskId,
            );
          }
        }
      } else {
        for await (const output of this.executeOneShot(
          ref, runnerInput, controller, invocationKey, leaseKey, sandboxUid, protectionState,
          ownedBackgroundTaskId,
        )) {
          if (output.type === 'completed') finalResponse = output.response;
          else if (!leaseMonitor?.failure) yield output;
        }
      }
    } catch (err) {
      runError = err;
    } finally {
      if (leasePersisted && sandboxUid && backgroundShellRequested
        && !protectionState.backgroundMetadataObserved && !protectionState.recovery) {
        protectionState.preserveInvocationLease = true;
        protectionState.recovery = {
          expectedUid: sandboxUid,
          protectedUntil: new Date(Date.now() + UNKNOWN_BACKGROUND_SHELL_PROTECTION_MS).toISOString(),
          taskIds: [],
          reason: 'background shell runner ended without protection metadata',
        };
        finalResponse = {
          status: 'error',
          error: '后台 Shell 启动结果不确定，ACS 正在保留 lease 并核对本地 worker。',
        };
        runError = undefined;
      }
      let leaseFailure: Error | undefined;
      let completionFenceError: unknown;
      const shouldCompleteInvocation = leasePersisted && Boolean(sandboxUid)
        && !protectionState.preserveInvocationLease && !protectionState.originalSandboxGone;
      const completedAt = shouldCompleteInvocation ? new Date() : undefined;
      if (leasePersisted && protectionState.recovery && leaseMonitor) {
        recoveryOwnsLease = true;
        this.startBackgroundProtectionRecovery(
          ref, leaseKey, invocationKey, protectionState.recovery, leaseMonitor,
        );
      } else {
        if (shouldCompleteInvocation && sandboxUid && !leaseMonitor?.failure) {
          try {
            await establishInvocationCompletionFence(this.config, this.sandboxManager, ref.name, leaseKey, sandboxUid);
          } catch (err) {
            completionFenceError = err;
          }
        }
        leaseFailure = await leaseMonitor?.finish();
      }
      options.signal?.removeEventListener('abort', onExternalAbort);
      if (shouldCompleteInvocation && sandboxUid && completedAt && !leaseFailure) {
        if (completionFenceError) {
          this.logger.warn(
            `invocation_completion_fence_failed sandbox=${ref.name} invocation=${invocationKey}: ${errorMessage(completionFenceError)}`,
          );
          this.startInvocationCompletionRecovery(ref, leaseKey, invocationKey, sandboxUid, completedAt);
        } else {
          try {
            await this.sandboxManager.completeInvocation(ref.name, leaseKey, completedAt, sandboxUid);
          } catch (err) {
            this.logger.warn(`invocation_completion_failed sandbox=${ref.name} invocation=${invocationKey}: ${errorMessage(err)}`);
            this.startInvocationCompletionRecovery(ref, leaseKey, invocationKey, sandboxUid, completedAt);
          }
        }
      }
      this.invocations.delete(invocationKey);
      releaseActive?.();
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

  backgroundRecoveryCount(): number {
    return this.backgroundProtectionRecoveries.size + this.invocationCompletionRecoveries.size;
  }

  busySandboxNames(): Set<string> {
    return new Set(
      [...this.invocations.values()]
        .map((entry) => entry.sandboxName)
        .filter((name): name is string => Boolean(name)),
    );
  }

  async reconcileBackgroundShellProtections(): Promise<{ checked: number; failed: number }> {
    const sandboxes = await this.sandboxManager.listManagedSandboxes();
    let failed = 0;
    for (const sandbox of sandboxes) {
      let activeInvocationLease = false;
      try {
        ({ active: activeInvocationLease } = await this.sandboxManager.clearExpiredInvocationLeases(
          sandbox.name,
        ));
      } catch (err) {
        failed += 1;
        this.logger.warn(`invocation_lease_sweep_failed sandbox=${sandbox.name}: ${errorMessage(err)}`);
        continue;
      }
      // An expired invocation-only residue must not execute a runner (and therefore
      // must not touch last-active or create another invocation annotation).
      if (!sandbox.backgroundShellProtectedUntil && !activeInvocationLease) continue;
      if (!sandbox.workspaceId || !sandbox.sessionId) {
        failed += 1;
        continue;
      }
      const response = await this.execute({
        toolName: '__BackgroundShellReconcile',
        input: { fail_closed: true },
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

  /** Persist workspace protection or terminate only tasks owned by this invocation. */
  private async applyBackgroundShellProtection(
    ref: SandboxRef,
    response: ToolInvocationResponse,
    leaseKey: string,
    expectedUid: string,
    state: InvocationProtectionState,
    ownedBackgroundTaskId: string | undefined,
  ): Promise<void> {
    const raw = response.metadata?.backgroundShell;
    if (!raw || typeof raw !== 'object') return;
    state.backgroundMetadataObserved = true;
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
    const aggregateTaskIds = activeTaskIds.length > 0
      ? [...new Set(activeTaskIds)]
      : currentTaskActive ? [background.taskId as string] : [];
    const ownedTaskIds: string[] = currentTaskActive && ownedBackgroundTaskId
      && background.taskId === ownedBackgroundTaskId ? [ownedBackgroundTaskId] : [];
    const aggregateProtectionActive = aggregateTaskIds.length > 0
      || this.hasSafeBackgroundProtection(protectedUntilMs);
    const failClosedOrRecover = async (reason: string): Promise<never> => {
      if (ownedTaskIds.length > 0) {
        return await this.failClosedBackgroundTasks(
          ref, ownedTaskIds, leaseKey, expectedUid, state, reason, protectedUntil,
        );
      }
      state.recovery = {
        expectedUid,
        ...(protectedUntil ? { protectedUntil } : {}),
        taskIds: [],
        reason,
      };
      throw new Error(`后台 Shell 保护不确定，保留 invocation lease 重试且不终止无所有权任务: ${reason}`);
    };
    if (aggregateProtectionActive) state.preserveInvocationLease = true;
    if (aggregateTaskIds.length > 0 && !this.hasSafeBackgroundProtection(protectedUntilMs)) {
      await failClosedOrRecover('missing aggregate protection deadline');
    }
    let protectionError: unknown;
    try {
      if (!protectedUntil && protectionStateHasObservation(state)) {
        await this.sandboxManager.setBackgroundShellProtection(
          sandboxName, undefined, expectedUid, state.observedBackgroundProtectionGeneration,
        );
      } else {
        await this.sandboxManager.setBackgroundShellProtection(
          sandboxName, protectedUntil, expectedUid, undefined, leaseKey,
        );
      }
      state.observedBackgroundProtectionGeneration = protectedUntil ? leaseKey : null;
    } catch (err) {
      protectionError = err;
    }
    if (!protectionError) {
      if (aggregateProtectionActive && !this.hasSafeBackgroundProtection(protectedUntilMs)) {
        await failClosedOrRecover('aggregate protection deadline expired before persistence confirmation');
      }
      if (aggregateProtectionActive) state.preserveInvocationLease = false;
      return;
    }
    if (!aggregateProtectionActive) throw protectionError;
    let leaseError: unknown;
    try {
      await this.sandboxManager.setActiveInvocationLease(
        sandboxName, leaseKey, protectedUntil, expectedUid,
      );
    } catch (err) {
      leaseError = err;
    }
    if (!leaseError) {
      if (!this.hasSafeBackgroundProtection(protectedUntilMs)) {
        await failClosedOrRecover('aggregate protection deadline expired before fallback confirmation');
      }
      this.logger.warn(
        `background_shell_protection_fallback sandbox=${sandboxName} task=${String(background.taskId ?? aggregateTaskIds[0])}`,
      );
      return;
    }
    await failClosedOrRecover(
      `protection=${errorMessage(protectionError)} lease=${errorMessage(leaseError)}`,
    );
  }

  private async failClosedBackgroundTasks(
    ref: SandboxRef,
    taskIds: string[],
    leaseKey: string,
    expectedUid: string,
    state: InvocationProtectionState,
    reason: string,
    protectedUntil?: string,
  ): Promise<never> {
    if (taskIds.length === 0) throw new Error(`拒绝无所有权的后台任务终止: ${reason}`);
    const terminate = this.options.terminateBackgroundTasks
      ?? ((targetRef: SandboxRef, ids: string[]) => this.terminateBackgroundTasks(targetRef, ids));
    try {
      if (!await this.originalSandboxExists(ref.name, expectedUid)) {
        state.originalSandboxGone = true;
        state.preserveInvocationLease = false;
        throw new OriginalSandboxGoneError();
      }
      // A successful UID-bound lease renewal fences the original CR for the full
      // termination window. Without it, a same-name replacement could appear
      // between the UID check and the name-based runner operation.
      await this.establishBackgroundTerminationFence(ref.name, leaseKey, expectedUid);
      // The runner terminates and verifies only this invocation's owned task IDs.
      await terminate(ref, taskIds);
    } catch (terminationError) {
      if (terminationError instanceof OriginalSandboxGoneError) {
        throw new Error(`后台 Shell 原 Sandbox 已消失，拒绝操作同名新实例: ${reason}`);
      }
      state.recovery = {
        expectedUid,
        ...(protectedUntil ? { protectedUntil } : {}),
        taskIds: [...new Set(taskIds)],
        reason: `${reason} termination=${errorMessage(terminationError)}`,
      };
      throw new Error(
        `后台 Shell 保护持久化失败且终止任务失败，保留现有 invocation lease: ${state.recovery.reason}`,
      );
    }
    // No background process remains, so the short invocation lease can be cleared.
    state.preserveInvocationLease = false;
    throw new Error(`后台 Shell 保护持久化失败，已终止活跃任务: ${reason}`);
  }

  private backgroundTerminationWindowMs(): number {
    return Math.max(30_000, this.config.execTimeoutMs) + BACKGROUND_PROTECTION_CONFIRM_MARGIN_MS;
  }

  /** Persist a UID-bound fence that still covers termination after its lease CAS returns. */
  private async establishBackgroundTerminationFence(
    name: string,
    leaseKey: string,
    expectedUid: string,
  ): Promise<void> {
    const requiredRemainingMs = this.backgroundTerminationWindowMs();
    const leaseUntilMs = Date.now() + this.config.sandboxWaitTimeoutMs + requiredRemainingMs;
    await this.sandboxManager.setActiveInvocationLease(
      name, leaseKey, new Date(leaseUntilMs).toISOString(), expectedUid,
    );
    if (leaseUntilMs - Date.now() < requiredRemainingMs) {
      throw new Error('termination fence expired before persistence confirmation');
    }
  }

  /** The persisted deadline must remain useful after a potentially slow CAS completes. */
  private hasSafeBackgroundProtection(protectedUntilMs: number): boolean {
    return Number.isFinite(protectedUntilMs)
      && protectedUntilMs - BACKGROUND_PROTECTION_CONFIRM_MARGIN_MS > Date.now();
  }

  private async originalSandboxExists(name: string, expectedUid: string): Promise<boolean> {
    const manager = this.sandboxManager as SandboxManager & {
      getMutableSandboxUid?: (sandboxName: string) => Promise<string | null>;
    };
    const currentUid = typeof manager.getMutableSandboxUid === 'function'
      ? await manager.getMutableSandboxUid(name)
      : await manager.getSandboxUid(name);
    return currentUid === expectedUid;
  }

  private startInvocationCompletionRecovery(
    ref: SandboxRef,
    leaseKey: string,
    invocationKey: string,
    expectedUid: string,
    completedAt: Date,
  ): void {
    const promise = recoverInvocationCompletion({
      config: this.config, sandboxManager: this.sandboxManager, sandboxName: ref.name,
      leaseKey, expectedUid, completedAt, logger: this.logger,
      retryMs: Math.max(1, this.options.backgroundRecoveryRetryMs ?? 5_000),
    }).catch((err) => {
        this.logger.error(
          `invocation_completion_recovery_failed sandbox=${ref.name} invocation=${invocationKey}: ${errorMessage(err)}`,
        );
      })
      .finally(() => this.invocationCompletionRecoveries.delete(promise));
    this.invocationCompletionRecoveries.add(promise);
  }

  private startBackgroundProtectionRecovery(
    ref: SandboxRef,
    leaseKey: string,
    invocationKey: string,
    recovery: NonNullable<InvocationProtectionState['recovery']>,
    leaseMonitor: InvocationLeaseMonitor,
  ): void {
    const promise = this.recoverBackgroundProtection(ref, leaseKey, recovery, leaseMonitor)
      .catch((err) => {
        this.logger.error(
          `background_shell_recovery_failed sandbox=${ref.name} invocation=${invocationKey}: ${errorMessage(err)}`,
        );
      })
      .finally(() => this.backgroundProtectionRecoveries.delete(promise));
    this.backgroundProtectionRecoveries.add(promise);
  }

  private async recoverBackgroundProtection(
    ref: SandboxRef,
    leaseKey: string,
    recovery: NonNullable<InvocationProtectionState['recovery']>,
    leaseMonitor: InvocationLeaseMonitor,
  ): Promise<void> {
    const retryMs = Math.max(1, this.options.backgroundRecoveryRetryMs ?? 5_000);
    const terminate = this.options.terminateBackgroundTasks
      ?? ((targetRef: SandboxRef, ids: string[]) => this.terminateBackgroundTasks(targetRef, ids));
    let monitorFailureLogged = false;
    // No initial sleep: under total write failure the original short lease is the
    // only provable marker, so renew it immediately while retrying a safety proof.
    for (;;) {
      try {
        if (!await this.originalSandboxExists(ref.name, recovery.expectedUid)) {
          await leaseMonitor.finish();
          this.logger.info(`background_shell_recovery_original_gone sandbox=${ref.name}`);
          return;
        }
      } catch (err) {
        this.logger.warn(`background_shell_recovery_uid_check_failed sandbox=${ref.name}: ${errorMessage(err)}`);
        await unrefDelay(retryMs);
        continue;
      }
      if (leaseMonitor.failure && !monitorFailureLogged) {
        monitorFailureLogged = true;
        this.logger.warn(
          `background_shell_recovery_lease_monitor_failed sandbox=${ref.name}: ${leaseMonitor.failure.message}`,
        );
      }
      try {
        await this.sandboxManager.setActiveInvocationLease(
          ref.name,
          leaseKey,
          new Date(Date.now() + ACTIVE_INVOCATION_LEASE_MS).toISOString(),
          recovery.expectedUid,
        );
      } catch (err) {
        this.logger.warn(`background_shell_recovery_lease_renew_failed sandbox=${ref.name}: ${errorMessage(err)}`);
      }

      let safe = false;
      const taskIds = recovery.taskIds;
      const protectedUntil = recovery.protectedUntil;
      const protectedUntilMs = protectedUntil ? Date.parse(protectedUntil) : Number.NaN;
      if (protectedUntil && this.hasSafeBackgroundProtection(protectedUntilMs)) {
        try {
          await this.sandboxManager.setBackgroundShellProtection(
            ref.name, protectedUntil, recovery.expectedUid, undefined, leaseKey,
          );
          // Re-check after CAS completion; an expired marker is not durable safety.
          safe = this.hasSafeBackgroundProtection(protectedUntilMs);
        } catch (err) {
          this.logger.warn(`background_shell_recovery_protection_failed sandbox=${ref.name}: ${errorMessage(err)}`);
        }
      }
      if (!safe && taskIds.length === 0) {
        try {
          const inventory = await this.reconcileBackgroundTaskInventory(ref);
          if (inventory.activeTaskIds.length === 0) {
            safe = true;
          } else if (inventory.protectedUntil) {
            const inventoryUntilMs = Date.parse(inventory.protectedUntil);
            if (this.hasSafeBackgroundProtection(inventoryUntilMs)) {
              await this.sandboxManager.setBackgroundShellProtection(
                ref.name, inventory.protectedUntil, recovery.expectedUid, undefined, leaseKey,
              );
              safe = this.hasSafeBackgroundProtection(inventoryUntilMs);
            }
          }
        } catch (err) {
          this.logger.warn(`background_shell_recovery_reconcile_failed sandbox=${ref.name}: ${errorMessage(err)}`);
        }
      }
      if (!safe && taskIds.length > 0) {
        try {
          if (!await this.originalSandboxExists(ref.name, recovery.expectedUid)) {
            await leaseMonitor.finish();
            this.logger.info(`background_shell_recovery_original_gone sandbox=${ref.name}`);
            return;
          }
          await this.establishBackgroundTerminationFence(ref.name, leaseKey, recovery.expectedUid);
          await terminate(ref, taskIds);
          safe = true;
        } catch (err) {
          this.logger.warn(`background_shell_recovery_termination_failed sandbox=${ref.name}: ${errorMessage(err)}`);
        }
      }
      if (!safe) {
        await unrefDelay(retryMs);
        continue;
      }

      // Stop renewal before clearing, otherwise an in-flight monitor tick could
      // recreate the annotation after the successful clear.
      await leaseMonitor.finish();
      for (;;) {
        try {
          await this.sandboxManager.setActiveInvocationLease(
            ref.name, leaseKey, undefined, recovery.expectedUid,
          );
          this.logger.info(
            `background_shell_recovery_completed sandbox=${ref.name} reason=${recovery.reason}`,
          );
          return;
        } catch (err) {
          try {
            if (!await this.originalSandboxExists(ref.name, recovery.expectedUid)) {
              this.logger.info(`background_shell_recovery_original_gone sandbox=${ref.name}`);
              return;
            }
          } catch (uidError) {
            this.logger.warn(`background_shell_recovery_uid_check_failed sandbox=${ref.name}: ${errorMessage(uidError)}`);
          }
          this.logger.warn(`background_shell_recovery_lease_clear_failed sandbox=${ref.name}: ${errorMessage(err)}`);
          await unrefDelay(retryMs);
        }
      }
    }
  }

  private async reconcileBackgroundTaskInventory(
    ref: SandboxRef,
  ): Promise<{ protectedUntil?: string; activeTaskIds: string[] }> {
    if (this.options.reconcileBackgroundTasks) return await this.options.reconcileBackgroundTasks(ref);
    const response = await this.invokeDirectRunner(ref, {
      toolName: '__BackgroundShellReconcile',
      input: {},
      workspace: {
        id: ref.workspaceId,
        sessionId: ref.sessionId,
        root: this.config.workspaceMountPath,
      },
      stream: false,
    });
    if (response.status === 'error') throw new Error(response.error);
    const raw = response.metadata?.backgroundShell as {
      protectedUntil?: unknown;
      activeTaskIds?: unknown;
    } | undefined;
    if (!Array.isArray(raw?.activeTaskIds)
      || raw.activeTaskIds.some((taskId) => typeof taskId !== 'string')) {
      throw new Error('后台任务核对未返回合法 activeTaskIds');
    }
    const protectedUntil = typeof raw.protectedUntil === 'string' ? raw.protectedUntil : undefined;
    return { ...(protectedUntil ? { protectedUntil } : {}), activeTaskIds: raw.activeTaskIds as string[] };
  }

  private async terminateBackgroundTasks(ref: SandboxRef, taskIds: string[]): Promise<void> {
    if (taskIds.length === 0) throw new Error('拒绝无所有权的后台任务终止请求');
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
    if (!Array.isArray(remaining) || remaining.some((taskId) => typeof taskId !== 'string')) {
      throw new Error('后台任务终止后未得到合法 activeTaskIds 确认');
    }
    const requested = new Set(taskIds);
    const stillActive = remaining.filter((taskId) => requested.has(taskId as string));
    if (stillActive.length > 0) {
      throw new Error(`后台任务终止后仍处于活动状态: ${stillActive.join(',')}`);
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
    sandboxUid: string,
    protectionState: InvocationProtectionState,
    ownedBackgroundTaskId: string | undefined,
  ): AsyncIterable<ToolInvocationStreamChunk> {
    const child = this.spawnRunner(ref, runnerInput, controller);
    const closePromise = waitForClose(child);
    this.invocations.set(invocationKey, { controller, child, sandboxName: ref.name });
    yield { type: 'progress', message: 'acs sandbox invocation accepted' };
    // Protection persistence shares the parent invocation lease and task ownership state.
    let sawCompleted = false;
    for await (const line of readLines(child)) {
      const parsed = parseRunnerLine(line);
      if (!parsed) continue;
      if (parsed.kind === 'chunk') {
        if (parsed.chunk.type === 'completed') {
          sawCompleted = true;
          const response = addRunnerMetadata(parsed.chunk.response, 'one-shot');
          await this.applyBackgroundShellProtection(
            ref, response, leaseKey, sandboxUid, protectionState, ownedBackgroundTaskId,
          );
          yield { ...parsed.chunk, response };
          continue;
        }
        yield parsed.chunk;
      } else {
        sawCompleted = true;
        const response = addRunnerMetadata(parsed.response, 'one-shot');
        await this.applyBackgroundShellProtection(
          ref, response, leaseKey, sandboxUid, protectionState, ownedBackgroundTaskId,
        );
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

function isBackgroundShellRequest(request: WireToolInvocationRequest): boolean {
  return request.toolName === 'Shell'
    && Boolean(request.input)
    && typeof request.input === 'object'
    && (request.input as Record<string, unknown>).mode === 'background';
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

class OriginalSandboxGoneError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function unrefDelay(ms: number): Promise<void> {
  // Recovery timers must not keep an otherwise drained process alive.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function protectionStateHasObservation(
  state: InvocationProtectionState,
): state is InvocationProtectionState & { observedBackgroundProtectionGeneration: string | null } {
  return state.observedBackgroundProtectionGeneration !== undefined;
}

function addRunnerMetadata(
  response: ToolInvocationResponse,
  mode: 'persistent' | 'one-shot',
): ToolInvocationResponse {
  return { ...response, metadata: { ...(response.metadata ?? {}), acsRunner: { mode } } };
}
