import type { SandboxRunnerFinalOutput, SandboxRunnerInput, SandboxRunnerOutput } from './protocol.js';

export const RUNNER_DAEMON_PROTOCOL_VERSION = 1;

export interface RunnerDaemonInvoke {
  kind: 'invoke';
  invocationKey: string;
  input: SandboxRunnerInput;
}

export interface RunnerDaemonCancel {
  kind: 'cancel';
  invocationKey: string;
}

export interface RunnerDaemonPing {
  kind: 'ping';
  nonce: string;
}

export type RunnerDaemonRequest = RunnerDaemonInvoke | RunnerDaemonCancel | RunnerDaemonPing;

export interface RunnerDaemonReady {
  kind: 'daemon_ready';
  protocolVersion: number;
  runnerId: string;
  imageRef?: string;
  /** Absent on legacy daemons; writers must explicitly negotiate capabilities. */
  capabilities?: string[];
  podUid?: string;
}

export interface RunnerDaemonHeartbeat {
  kind: 'daemon_heartbeat';
  runnerId: string;
  at: number;
}

export interface RunnerDaemonPong {
  kind: 'daemon_pong';
  nonce: string;
}

export interface RunnerDaemonInvocationOutput {
  kind: 'invocation_output';
  invocationKey: string;
  output: SandboxRunnerOutput | SandboxRunnerFinalOutput;
}

export type RunnerDaemonResponse =
  | RunnerDaemonReady
  | RunnerDaemonHeartbeat
  | RunnerDaemonPong
  | RunnerDaemonInvocationOutput;

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);
}

export function parseRunnerDaemonRequest(value: unknown): RunnerDaemonRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'invoke' && identifier(raw.invocationKey) && raw.input && typeof raw.input === 'object' && !Array.isArray(raw.input)) {
    return { kind: 'invoke', invocationKey: raw.invocationKey, input: raw.input as SandboxRunnerInput };
  }
  if (raw.kind === 'cancel' && identifier(raw.invocationKey)) return { kind: 'cancel', invocationKey: raw.invocationKey };
  if (raw.kind === 'ping' && identifier(raw.nonce)) return { kind: 'ping', nonce: raw.nonce };
  return null;
}

export function parseRunnerDaemonResponse(value: unknown): RunnerDaemonResponse | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'daemon_ready' && typeof raw.protocolVersion === 'number'
    && Number.isSafeInteger(raw.protocolVersion) && identifier(raw.runnerId)) {
    if (raw.podUid !== undefined && !identifier(raw.podUid)) return null;
    if (raw.capabilities !== undefined && (!Array.isArray(raw.capabilities) || raw.capabilities.length > 16
      || raw.capabilities.some((item) => typeof item !== 'string' || !/^[a-z0-9-]{1,64}$/.test(item)))) return null;
    return {
      kind: 'daemon_ready', protocolVersion: raw.protocolVersion, runnerId: raw.runnerId,
      ...(typeof raw.imageRef === 'string' ? { imageRef: raw.imageRef } : {}),
      ...(typeof raw.podUid === 'string' ? { podUid: raw.podUid } : {}),
      ...(Array.isArray(raw.capabilities) ? { capabilities: [...new Set(raw.capabilities as string[])] } : {}),
    };
  }
  if (raw.kind === 'daemon_heartbeat' && identifier(raw.runnerId) && typeof raw.at === 'number' && Number.isFinite(raw.at)) {
    return { kind: 'daemon_heartbeat', runnerId: raw.runnerId, at: raw.at };
  }
  if (raw.kind === 'daemon_pong' && identifier(raw.nonce)) return { kind: 'daemon_pong', nonce: raw.nonce };
  if (raw.kind === 'invocation_output' && identifier(raw.invocationKey) && raw.output
    && typeof raw.output === 'object' && !Array.isArray(raw.output)) {
    return { kind: 'invocation_output', invocationKey: raw.invocationKey,
      output: raw.output as SandboxRunnerOutput | SandboxRunnerFinalOutput };
  }
  return null;
}
