import type { ChildProcessWithoutNullStreams } from 'node:child_process';

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
import type { SandboxManager, SandboxRef } from './sandboxManager.js';
import type { ToolInvocationResponse, ToolInvocationStreamChunk } from 'server/runtime/handProtocol.js';

interface InvocationEntry {
  controller: AbortController;
  child?: ChildProcessWithoutNullStreams;
  sandboxName?: string;
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
    private readonly options: { persistentRunner?: boolean } = {},
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
    const ref = this.sandboxManager.ref({
      workspaceId: workspace.id!,
      sessionId: workspace.sessionId!,
      sandboxScopeId: workspace.sandboxScopeId,
      mountSubPath: workspace.mountSubPath,
    });
    const invocationId = request.context.invocationId;
    const invocationKey = invocationId ?? `internal-${Date.now()}-${++this.invocationSeq}`;
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
    try {
      const sandboxIdentity = {
        workspaceId: workspace.id!,
        sessionId: workspace.sessionId!,
        sandboxScopeId: workspace.sandboxScopeId,
        mountSubPath: workspace.mountSubPath,
      };
      await this.ensureSandboxRunning(ref, sandboxIdentity, invocationKey);
      if (controller.signal.aborted) return;
      // 07-05：把 wire.context.env（parseWireRequest 已 allowlist 过滤过）透传给
      // pod 内 sandboxRunner，让其合并进 spawn 子进程的 env，pod 里 Shell 才能
      // 拿到 AZEROTH_TOKEN 等凭据。env 为空则不写字段（wire 更紧凑，与协议一致）。
      const wireEnv = request.context.env;
      const runnerInput: SandboxRunnerInput = {
        toolName: toolNameForSandboxRunner(request.toolName),
        input: request.input,
        invocationId,
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
      if (controller.signal.aborted) return;
      if (runner) {
        yield { type: 'progress', message: 'acs sandbox invocation accepted' };
        for await (const output of runner.invoke(invocationKey, runnerInput, controller.signal)) {
          if (output.kind === 'chunk') {
            if (output.chunk.type === 'completed') {
              const response = addRunnerMetadata(output.chunk.response, 'persistent');
              await this.applyBackgroundShellProtection(ref.name, response);
              yield { ...output.chunk, response };
            } else {
              yield output.chunk;
            }
          } else {
            const response = addRunnerMetadata(output.response, 'persistent');
            await this.applyBackgroundShellProtection(ref.name, response);
            yield { type: 'completed', response };
          }
        }
      } else {
        yield* this.executeOneShot(ref, runnerInput, controller, invocationKey);
      }
    } finally {
      options.signal?.removeEventListener('abort', onExternalAbort);
      this.invocations.delete(invocationKey);
      releaseActive?.();
    }
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
      .filter((sandbox) => Boolean(sandbox.backgroundShellProtectedUntil));
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

  private async applyBackgroundShellProtection(sandboxName: string, response: ToolInvocationResponse): Promise<void> {
    const raw = response.metadata?.backgroundShell;
    if (!raw || typeof raw !== 'object') return;
    const protectedUntil = typeof (raw as { protectedUntil?: unknown }).protectedUntil === 'string'
      ? (raw as { protectedUntil: string }).protectedUntil
      : undefined;
    await this.sandboxManager.setBackgroundShellProtection(sandboxName, protectedUntil);
  }

  private async ensureSandboxRunning(
    ref: SandboxRef,
    identity: { workspaceId: string; sessionId: string; sandboxScopeId?: string; mountSubPath?: string },
    invocationKey: string,
  ): Promise<void> {
    const existingRunner = this.persistentRunners.get(ref.name);
    const lastEnsure = this.ensureRunningAt.get(ref.name) ?? 0;
    if (existingRunner?.isHealthy() && Date.now() - lastEnsure < 60_000) return;
    const pending = this.ensureRunningPromises.get(ref.name);
    if (pending) return await pending;
    const ensure = this.sandboxManager.ensureRunning(identity, {
      busySandboxNames: this.busySandboxNames(),
      activeKey: invocationKey,
    }).then(() => {
      this.ensureRunningAt.set(ref.name, Date.now());
    }).finally(() => {
      this.ensureRunningPromises.delete(ref.name);
    });
    this.ensureRunningPromises.set(ref.name, ensure);
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
  ): AsyncIterable<ToolInvocationStreamChunk> {
    const child = this.spawnRunner(ref, runnerInput, controller);
    const closePromise = waitForClose(child);
    this.invocations.set(invocationKey, { controller, child, sandboxName: ref.name });
    yield { type: 'progress', message: 'acs sandbox invocation accepted' };
    let sawCompleted = false;
    for await (const line of readLines(child)) {
      const parsed = parseRunnerLine(line);
      if (!parsed) continue;
      if (parsed.kind === 'chunk') {
        if (parsed.chunk.type === 'completed') {
          sawCompleted = true;
          const response = addRunnerMetadata(parsed.chunk.response, 'one-shot');
          await this.applyBackgroundShellProtection(ref.name, response);
          yield { ...parsed.chunk, response };
          continue;
        }
        yield parsed.chunk;
      } else {
        sawCompleted = true;
        const response = addRunnerMetadata(parsed.response, 'one-shot');
        await this.applyBackgroundShellProtection(ref.name, response);
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
      if (text) this.logger.warn(`kubectl_exec_stderr sandbox=${ref.name}: ${text}`);
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

function addRunnerMetadata(
  response: ToolInvocationResponse,
  mode: 'persistent' | 'one-shot',
): ToolInvocationResponse {
  return { ...response, metadata: { ...(response.metadata ?? {}), acsRunner: { mode } } };
}
