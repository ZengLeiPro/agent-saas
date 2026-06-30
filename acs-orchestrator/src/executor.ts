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
import type { SandboxManager, SandboxRef } from './sandboxManager.js';
import type { ToolInvocationResponse, ToolInvocationStreamChunk } from 'server/runtime/handProtocol.js';

interface InvocationEntry {
  controller: AbortController;
  child?: ChildProcessWithoutNullStreams;
  sandboxName?: string;
}

export class AcsExecutor {
  private readonly invocations = new Map<string, InvocationEntry>();
  private invocationSeq = 0;

  constructor(
    private readonly config: AcsOrchestratorConfig,
    private readonly kubectl: Kubectl,
    private readonly sandboxManager: SandboxManager,
    private readonly logger: { info(msg: string): void; warn(msg: string): void; error(msg: string): void },
    private readonly activeRegistry?: ActiveSandboxRegistry,
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
    options: { stream: boolean },
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
    const releaseActive = this.activeRegistry?.acquire(ref.name, invocationKey);
    const controller = new AbortController();
    try {
      await this.sandboxManager.ensureRunning({
        workspaceId: workspace.id!,
        sessionId: workspace.sessionId!,
        sandboxScopeId: workspace.sandboxScopeId,
        mountSubPath: workspace.mountSubPath,
      }, {
        busySandboxNames: this.busySandboxNames(),
        activeKey: invocationKey,
      });
      this.invocations.set(invocationKey, { controller, sandboxName: ref.name });
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
      };
      const child = this.spawnRunner(ref, runnerInput, controller);
      const closePromise = waitForClose(child);
      this.invocations.set(invocationKey, { controller, child, sandboxName: ref.name });
      yield { type: 'progress', message: 'acs sandbox invocation accepted' };
      let sawCompleted = false;
      for await (const line of readLines(child)) {
        const parsed = parseRunnerLine(line);
        if (!parsed) continue;
        if (parsed.kind === 'chunk') {
          if (parsed.chunk.type === 'completed') sawCompleted = true;
          yield parsed.chunk;
        } else {
          sawCompleted = true;
          yield { type: 'completed', response: parsed.response };
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
    } finally {
      this.invocations.delete(invocationKey);
      releaseActive?.();
    }
  }

  cancel(invocationId: string): boolean {
    const entry = this.invocations.get(invocationId);
    if (!entry) return false;
    entry.controller.abort();
    entry.child?.kill('SIGTERM');
    return true;
  }

  busySandboxNames(): Set<string> {
    return new Set(
      [...this.invocations.values()]
        .map((entry) => entry.sandboxName)
        .filter((name): name is string => Boolean(name)),
    );
  }

  private spawnRunner(ref: SandboxRef, input: SandboxRunnerInput, controller: AbortController): ChildProcessWithoutNullStreams {
    const args = [
      'exec',
      '-i',
      ref.name,
      '-c',
      this.config.sandboxContainerName,
      '--',
      '/app/acs-orchestrator/node_modules/.bin/tsx',
      '/app/acs-orchestrator/src/sandboxRunner.ts',
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
    case 'List':
      return 'list_files';
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
