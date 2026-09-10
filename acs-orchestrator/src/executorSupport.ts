import type { WireToolInvocationRequest } from './protocol.js';
import type { ToolInvocationResponse } from 'server/runtime/handProtocol.js';

export interface InvocationProtectionState {
  preserveInvocationLease: boolean;
  backgroundMetadataObserved?: boolean;
  runnerTerminalObserved?: boolean;
  remoteNeverStarted?: boolean;
  observedBackgroundProtectionGeneration?: string | null;
  originalSandboxGone?: boolean;
  recovery?: {
    expectedUid: string;
    protectedUntil?: string;
    taskIds: string[];
    reason: string;
    launchUncertain?: true;
  };
}

export function isBackgroundShellRequest(request: WireToolInvocationRequest): boolean {
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

export class OriginalSandboxGoneError extends Error {}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function unrefDelay(ms: number): Promise<void> {
  // Recovery timers must not keep an otherwise drained process alive.
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export function protectionStateHasObservation(
  state: InvocationProtectionState,
): state is InvocationProtectionState & { observedBackgroundProtectionGeneration: string | null } {
  return state.observedBackgroundProtectionGeneration !== undefined;
}

export function addRunnerMetadata(
  response: ToolInvocationResponse,
  mode: 'persistent' | 'one-shot',
): ToolInvocationResponse {
  return { ...response, metadata: { ...(response.metadata ?? {}), acsRunner: { mode } } };
}
