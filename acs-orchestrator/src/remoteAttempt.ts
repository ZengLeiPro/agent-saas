import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { SandboxRunnerInput, SandboxRunnerFinalOutput, SandboxRunnerOutput } from './protocol.js';
import { invocationTransportBudget, remoteUnknownResponse } from './runnerTransport.js';
import { REMOTE_CONTROL_FRAME_BYTES, type RemoteAttemptFence } from './remoteAttemptProtocol.js';

type Output = SandboxRunnerOutput | SandboxRunnerFinalOutput;
const POD_IDENTITY_PATH = '/var/run/acs-identity/pod-uid';

export function remoteControlAsset(name: 'attempt_supervisor.py' | 'attempt_control.py' | 'dws_receiver.py'): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, 'remote', name), join(here, '..', 'src', 'remote', name)];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`ACS remote control asset is absent: ${name}`);
  return found;
}

function workerCommand(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundle = ['sandboxRunner.mjs', 'sandboxRunner.js'].map((name) => join(here, name)).find((path) => existsSync(path));
  if (bundle) return [process.execPath, bundle, '--owned-child'];
  // Source-only development still executes a separate process; it never places
  // synchronous Python/bootstrap work back on the shared daemon event loop.
  return [process.execPath, '--import', 'tsx', join(here, 'sandboxRunner.ts'), '--owned-child'];
}

export function readRunnerPodUid(): string | undefined {
  try { return readFileSync(POD_IDENTITY_PATH, 'utf8').trim() || undefined; }
  catch { return undefined; }
}

export async function runRemoteAttempt(
  input: SandboxRunnerInput,
  signal: AbortSignal,
  emit: (output: Output) => void,
): Promise<void> {
  if (signal.aborted) return;
  const supplied = (input as SandboxRunnerInput & { executionFence?: RemoteAttemptFence }).executionFence;
  const podUid = readRunnerPodUid();
  if (!podUid) {
    emit({ kind: 'final', response: remoteUnknownResponse('pod_identity_mount_unavailable') });
    return;
  }
  const fence: RemoteAttemptFence = supplied ?? {
    protocolVersion: 1, operationId: `legacy-${randomUUID()}`, attemptId: `legacy-${randomUUID()}`,
    ownerId: 'legacy-wire-owner', sandboxUid: 'legacy-unverified', podUid, startBeforeMs: Date.now() + 60_000,
  };
  if (fence.podUid !== podUid || fence.startBeforeMs < Date.now()) {
    emit({ kind: 'final', response: remoteUnknownResponse('attempt_dispatch_fence_rejected') });
    return;
  }
  const child = spawn('python3', [remoteControlAsset('attempt_supervisor.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let observedTerminal = false;
  let parseFailed = false;
  const cancel = () => {
    try { child.stdin.write(`${JSON.stringify({ kind: 'cancel', fence })}\n`); }
    catch { /* The durable receipt/journal remains the owner. */ }
  };
  const accept = (line: string) => {
    if (!line.trim()) return;
    try {
      const output = JSON.parse(line) as Output;
      if (!output || (output.kind !== 'chunk' && output.kind !== 'final')) throw new Error('invalid frame');
      if (output.kind === 'final') observedTerminal = true;
      emit(output);
    } catch {
      if (!parseFailed) {
        parseFailed = true;
        cancel();
        emit({ kind: 'final', response: remoteUnknownResponse('supervisor_frame_invalid') });
      }
    }
  };
  // Observers are installed before stdin writes, including for immediate spawn errors.
  const finished = new Promise<void>((resolve) => {
    child.once('error', () => {
      emit({ kind: 'final', response: remoteUnknownResponse('supervisor_spawn_failed') });
      resolve();
    });
    child.once('close', () => {
      buffer += decoder.end();
      if (buffer.trim()) accept(buffer);
      if (!observedTerminal) emit({ kind: 'final', response: remoteUnknownResponse('supervisor_closed_without_receipt') });
      resolve();
    });
  });
  child.stdin.on('error', () => undefined);
  child.stdout.on('error', () => cancel());
  child.stderr.on('error', () => undefined);
  child.stderr.on('data', () => { /* Drain bounded control-plane diagnostics; do not expose credentials. */ });
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer) > REMOTE_CONTROL_FRAME_BYTES) {
      buffer = '';
      parseFailed = true;
      cancel();
      emit({ kind: 'final', response: remoteUnknownResponse('supervisor_frame_limit') });
      return;
    }
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      accept(line);
    }
  });
  signal.addEventListener('abort', cancel, { once: true });
  child.stdin.write(`${JSON.stringify({ protocolVersion: 1, fence, input,
    workspaceRoot: input.workspace.root || '/workspace', command: workerCommand(),
    timeoutMs: invocationTransportBudget(input), identityPath: POD_IDENTITY_PATH })}\n`);
  if (signal.aborted) cancel();
  try { await finished; }
  finally { signal.removeEventListener('abort', cancel); child.stdin.destroy(); }
}
