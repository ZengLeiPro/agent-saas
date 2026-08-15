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

export function parseRunnerDaemonRequest(value: unknown): RunnerDaemonRequest | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'invoke' && typeof raw.invocationKey === 'string' && raw.input && typeof raw.input === 'object') {
    return { kind: 'invoke', invocationKey: raw.invocationKey, input: raw.input as SandboxRunnerInput };
  }
  if (raw.kind === 'cancel' && typeof raw.invocationKey === 'string') {
    return { kind: 'cancel', invocationKey: raw.invocationKey };
  }
  if (raw.kind === 'ping' && typeof raw.nonce === 'string') {
    return { kind: 'ping', nonce: raw.nonce };
  }
  return null;
}

export function parseRunnerDaemonResponse(value: unknown): RunnerDaemonResponse | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.kind === 'daemon_ready'
    && typeof raw.protocolVersion === 'number'
    && typeof raw.runnerId === 'string'
  ) {
    return {
      kind: 'daemon_ready',
      protocolVersion: raw.protocolVersion,
      runnerId: raw.runnerId,
      ...(typeof raw.imageRef === 'string' ? { imageRef: raw.imageRef } : {}),
    };
  }
  if (raw.kind === 'daemon_heartbeat' && typeof raw.runnerId === 'string' && typeof raw.at === 'number') {
    return { kind: 'daemon_heartbeat', runnerId: raw.runnerId, at: raw.at };
  }
  if (raw.kind === 'daemon_pong' && typeof raw.nonce === 'string') {
    return { kind: 'daemon_pong', nonce: raw.nonce };
  }
  if (
    raw.kind === 'invocation_output'
    && typeof raw.invocationKey === 'string'
    && raw.output
    && typeof raw.output === 'object'
  ) {
    return {
      kind: 'invocation_output',
      invocationKey: raw.invocationKey,
      output: raw.output as SandboxRunnerOutput | SandboxRunnerFinalOutput,
    };
  }
  return null;
}
