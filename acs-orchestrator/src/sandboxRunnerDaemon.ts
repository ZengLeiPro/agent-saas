import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import type { SandboxRunnerFinalOutput, SandboxRunnerInput, SandboxRunnerOutput } from './protocol.js';
import {
  parseRunnerDaemonRequest,
  RUNNER_DAEMON_PROTOCOL_VERSION,
  type RunnerDaemonResponse,
} from './runnerDaemonProtocol.js';

const HEARTBEAT_INTERVAL_MS = 15_000;

export interface SandboxRunnerDaemonOptions {
  execute(
    input: SandboxRunnerInput,
    signal: AbortSignal,
    emit: (output: SandboxRunnerOutput | SandboxRunnerFinalOutput) => void,
  ): Promise<void>;
  stdin?: NodeJS.ReadableStream;
  write?: (response: RunnerDaemonResponse) => void;
  runnerId?: string;
  imageRef?: string;
  heartbeatIntervalMs?: number;
}

export async function runSandboxRunnerDaemon(options: SandboxRunnerDaemonOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const write = options.write ?? ((response) => process.stdout.write(`${JSON.stringify(response)}\n`));
  const runnerId = options.runnerId ?? randomUUID();
  const controllers = new Map<string, AbortController>();
  const heartbeat = setInterval(() => {
    write({ kind: 'daemon_heartbeat', runnerId, at: Date.now() });
  }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  write({
    kind: 'daemon_ready',
    protocolVersion: RUNNER_DAEMON_PROTOCOL_VERSION,
    runnerId,
    ...(options.imageRef ? { imageRef: options.imageRef } : {}),
  });

  const abortAll = () => {
    for (const controller of controllers.values()) controller.abort();
  };
  process.once('SIGTERM', abortAll);
  process.once('SIGINT', abortAll);
  process.once('SIGHUP', abortAll);

  try {
    const lines = createInterface({ input: stdin });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const request = parseRunnerDaemonRequest(parsed);
      if (!request) continue;
      if (request.kind === 'ping') {
        write({ kind: 'daemon_pong', nonce: request.nonce });
        continue;
      }
      if (request.kind === 'cancel') {
        controllers.get(request.invocationKey)?.abort();
        continue;
      }
      if (controllers.has(request.invocationKey)) {
        write({
          kind: 'invocation_output',
          invocationKey: request.invocationKey,
          output: {
            kind: 'final',
            response: { status: 'error', error: `runner invocation already active: ${request.invocationKey}` },
          },
        });
        continue;
      }
      const controller = new AbortController();
      controllers.set(request.invocationKey, controller);
      void options.execute(request.input, controller.signal, (output) => {
        write({ kind: 'invocation_output', invocationKey: request.invocationKey, output });
      }).catch((err) => {
        write({
          kind: 'invocation_output',
          invocationKey: request.invocationKey,
          output: {
            kind: 'final',
            response: { status: 'error', error: err instanceof Error ? err.message : String(err) },
          },
        });
      }).finally(() => {
        controllers.delete(request.invocationKey);
      });
    }
  } finally {
    clearInterval(heartbeat);
    abortAll();
    process.removeListener('SIGTERM', abortAll);
    process.removeListener('SIGINT', abortAll);
    process.removeListener('SIGHUP', abortAll);
  }
}
