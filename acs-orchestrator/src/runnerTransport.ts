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
  const args = [
    'exec', '-i', ref.name, '-c', config.sandboxContainerName, '--',
    // 2026-08-10（A 方案批次 3）：优先跑镜像内预编译的单文件 ESM。
    // pod 内实测 tsx 实时转译 480~730ms vs 预编译 68ms（快 7~9 倍），
    // 这是每一次工具调用都要付的固定底噪。
    //
    // 用 sh -c 做运行期存在性判断而非直接指向 .mjs：蓝绿/回滚期间可能短暂
    // 跑到不含该产物的旧镜像，此时静默退回 tsx 保持可用（宁可慢，不可不可用）。
    // 镜像构建侧已对产物做 fail-fast 校验，正常路径不会走到 fallback。
    '/bin/sh', '-c',
    'if [ -s /app/acs-orchestrator/dist/sandboxRunner.mjs ]; then '
      + 'exec node /app/acs-orchestrator/dist/sandboxRunner.mjs; '
      + 'else exec /app/acs-orchestrator/node_modules/.bin/tsx /app/acs-orchestrator/src/sandboxRunner.ts; fi',
  ];
  const child = kubectl.spawn(args, { input: JSON.stringify(input), signal: controller.signal });
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
