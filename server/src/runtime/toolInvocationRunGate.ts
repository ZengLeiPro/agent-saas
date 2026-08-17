import type { ToolInvocationRecord } from './toolInvocationStore.js';

export type ToolInvocationRunGateRunState = string | {
  status: string;
  workerId?: string;
  leaseExpiresAt?: string;
};

export type ToolInvocationRunGateResult<T> =
  | { invoked: true; result: T }
  | {
    invoked: false;
    reason: 'run_missing' | 'run_terminal' | 'run_lease_lost' | 'invocation_missing' | 'invocation_terminal' | 'cancel_requested' | 'invocation_claimed';
    invocation: ToolInvocationRecord | null;
    runStatus?: string;
    runWorkerId?: string;
  };

export async function invokeWithInMemoryActiveRunGate<T>(
  invocations: Map<string, ToolInvocationRecord>,
  runId: string,
  invocationId: string,
  invoke: () => Promise<T>,
  readRunStatus?: () => Promise<ToolInvocationRunGateRunState | null>,
  expectedWorkerId?: string,
): Promise<ToolInvocationRunGateResult<T>> {
  const runState = readRunStatus ? await readRunStatus() : null;
  const runStatus = typeof runState === 'string' ? runState : runState?.status;
  const structuredRunState = typeof runState === 'object' && runState ? runState : undefined;
  const runWorkerId = structuredRunState?.workerId;
  const leaseExpiresAt = structuredRunState?.leaseExpiresAt;
  const leaseExpiresAtMs = leaseExpiresAt ? Date.parse(leaseExpiresAt) : Number.NaN;
  const invocation = invocations.get(invocationId) ?? null;
  if (readRunStatus && !runStatus) {
    return { invoked: false, reason: 'run_missing', invocation };
  }
  if (expectedWorkerId && (
    runStatus !== 'running'
    || runWorkerId !== expectedWorkerId
    || !Number.isFinite(leaseExpiresAtMs)
    || leaseExpiresAtMs <= Date.now()
  )) {
    return { invoked: false, reason: 'run_lease_lost', invocation, runStatus, runWorkerId };
  }
  if (!invocation || invocation.runId !== runId) {
    return { invoked: false, reason: 'invocation_missing', invocation: null };
  }
  if (typeof invocation.metadata.invokeClaimedAt === 'string') {
    return { invoked: false, reason: 'invocation_claimed', invocation };
  }
  if (runStatus && ['completed', 'failed', 'cancelled', 'orphaned'].includes(runStatus)) {
    return { invoked: false, reason: 'run_terminal', invocation, runStatus };
  }
  if (invocation.status !== 'running') {
    return { invoked: false, reason: 'invocation_terminal', invocation };
  }
  if (invocation.cancelRequestedAt) {
    return { invoked: false, reason: 'cancel_requested', invocation };
  }
  const claimed: ToolInvocationRecord = {
    ...invocation,
    updatedAt: new Date().toISOString(),
    metadata: {
      ...invocation.metadata,
      invokeClaimedAt: new Date().toISOString(),
      ...(expectedWorkerId
        ? { invokeClaimedByWorkerId: expectedWorkerId }
        : typeof invocation.metadata.workerId === 'string'
          ? { invokeClaimedByWorkerId: invocation.metadata.workerId }
          : {}),
    },
  };
  invocations.set(invocationId, claimed);
  return { invoked: true, result: await invoke() };
}
