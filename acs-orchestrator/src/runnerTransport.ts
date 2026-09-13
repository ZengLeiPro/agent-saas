import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { SandboxRef } from './sandboxManagerTypes.js';
import type { SandboxRunnerInput, SandboxRunnerOutput, SandboxRunnerFinalOutput } from './protocol.js';
import type { ToolInvocationResponse } from 'server/runtime/handProtocol.js';
import { localProcessResult } from './localProcessSupervisor.js';
import { summarizeRunnerStderr } from './runnerLog.js';
import { OWNED_WAIT_BUDGETS } from './ownedWait.js';
import { pythonRunnerDaemonExecArgs } from './ownedPodIdentity.js';

type RunnerOutput = SandboxRunnerOutput | SandboxRunnerFinalOutput;

export function remoteUnknownResponse(reasonCode: string): ToolInvocationResponse {
  return {
    status: 'error', error: `ACS remote execution is unresolved (${reasonCode}); ownership is retained`,
    metadata: { remoteExecution: { state: 'unknown', reasonCode } },
  };
}

export function isRemoteUnknown(response: ToolInvocationResponse | undefined): boolean {
  const remote = response?.metadata?.remoteExecution;
  return Boolean(remote && typeof remote === 'object' && (remote as { state?: unknown }).state === 'unknown');
}

export function invocationTransportBudget(input: SandboxRunnerInput): number {
  const raw = input.input && typeof input.input === 'object' ? (input.input as Record<string, unknown>).timeoutMs : undefined;
  const requested = typeof raw === 'number' && Number.isFinite(raw) && raw > 0
    ? Math.min(raw, OWNED_WAIT_BUDGETS.maxLegacyListenerMs) : OWNED_WAIT_BUDGETS.maxForegroundMs;
  // Bootstrap has a separate allowance. Deployment drain is never a tool deadline.
  return requested + 6 * 60_000;
}

export function spawnOneShotRunner(
  config: AcsOrchestratorConfig,
  kubectl: Kubectl,
  ref: SandboxRef,
  input: SandboxRunnerInput,
  controller: AbortController,
  logger: { warn(message: string): void },
): ChildProcessWithoutNullStreams {
  const fenced = input as SandboxRunnerInput & { executionFence?: { podUid?: string } };
  const args = pythonRunnerDaemonExecArgs({
    sandboxName: ref.name,
    containerName: config.sandboxContainerName,
    interactive: true,
    oneshot: true,
    ownedPodUid: fenced.executionFence?.podUid,
  });
  const child = kubectl.spawn(args, { input: JSON.stringify(input), signal: controller.signal, timeoutMs: invocationTransportBudget(input) });
  void localProcessResult(child, { signal: controller.signal, timeoutMs: invocationTransportBudget(input), collectOutput: false });
  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8').trim();
    if (text) logger.warn(`kubectl_exec_stderr sandbox=${ref.name} ${summarizeRunnerStderr(text)}`);
  });
  return child;
}

export async function* readRunnerLines(child: ChildProcessWithoutNullStreams): AsyncIterable<string> {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const limit = 1024 * 1024;
  for await (const chunk of child.stdout) {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    let index: number;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line) > limit) throw new Error('ACS runner frame exceeds byte budget');
      if (line.trim()) yield line;
    }
    if (Buffer.byteLength(buffer) > limit) throw new Error('ACS runner partial frame exceeds byte budget');
  }
  buffer += decoder.end();
  if (buffer.trim()) yield buffer;
}

export function parseRunnerLine(line: string): RunnerOutput | null {
  try {
    const parsed = JSON.parse(line) as RunnerOutput;
    return parsed && typeof parsed === 'object' && (parsed.kind === 'chunk' || parsed.kind === 'final') ? parsed : null;
  } catch {
    return { kind: 'chunk', chunk: { type: 'output', channel: 'stdout', content: `${line}\n` } };
  }
}
