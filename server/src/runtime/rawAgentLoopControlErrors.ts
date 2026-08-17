import type { InteractionEvent } from '../agent/types.js';
import type { OutboundEvent } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import type { RunStore } from './runStore.js';
import type { ToolInvocationRecord } from './toolInvocationStore.js';
import type { ModelEvent, PlatformEventInput, RunContext } from './types.js';

const logger = createLogger('RawAgentLoop');

export async function* captureModelStreamError(
  stream: AsyncIterable<ModelEvent>,
  onError: (error: unknown) => void,
): AsyncGenerator<ModelEvent> {
  try {
    yield* stream;
  } catch (error) {
    onError(error);
  }
}

export async function handleInvocationClaimLoss(
  err: ToolInvocationClaimLostError,
  context: RunContext,
  runStore: RunStore | undefined,
  append: (event: PlatformEventInput) => Promise<void>,
  phase: string,
): Promise<OutboundEvent | null> {
  if (!context.workerId || !runStore) return null;
  const run = await runStore.get(context.runId).catch(() => null);
  if (
    run?.status !== 'running'
    || run.workerId !== context.workerId
    || (err.claimedWorkerId && err.claimedWorkerId === context.workerId)
  ) return null;
  await append({
    type: 'run_finished',
    runId: context.runId,
    sessionId: context.sessionId,
    subtype: 'error',
    numTurns: 0,
    error: err.message,
  });
  await context.hooks?.onResult?.({ subtype: 'error', numTurns: 0, resultText: '' });
  logger.error(
    `[${phase}] failed closed after stale invocation claim session=${context.sessionId} run=${context.runId}: ${err.message}`,
  );
  return { type: 'error', error: err.message };
}

export async function readRunLeaseState(runStore: RunStore, runId: string) {
  const run = await runStore.get(runId);
  return run ? { status: run.status, workerId: run.workerId, leaseExpiresAt: run.leaseExpiresAt } : null;
}

export function resolveClaimedWorkerId(invocation: ToolInvocationRecord | null | undefined): string | undefined {
  return typeof invocation?.metadata.invokeClaimedByWorkerId === 'string'
    ? invocation.metadata.invokeClaimedByWorkerId
    : typeof invocation?.metadata.workerId === 'string' ? invocation.metadata.workerId : undefined;
}

export class RunLeaseLostError extends Error {
  constructor(runId: string, expectedWorkerId?: string, currentWorkerId?: string) {
    super(
      `run lease lost before tool invocation: ${runId}`
      + ` expected=${expectedWorkerId ?? 'unknown'} current=${currentWorkerId ?? 'unknown'}`,
    );
    this.name = 'RunLeaseLostError';
  }
}

export class ToolInvocationClaimLostError extends Error {
  constructor(invocationId: string, readonly claimedWorkerId?: string) {
    super(`tool invocation already claimed by another worker: ${invocationId}`);
    this.name = 'ToolInvocationClaimLostError';
  }
}

export class ApprovalAlreadyResolvedError extends Error {
  constructor(approvalId: string) {
    super(`approval already resolved: ${approvalId}`);
    this.name = 'ApprovalAlreadyResolvedError';
  }
}

export class ApprovalPendingWithoutInteractionHook extends Error {
  constructor(approvalId: string) {
    super(`approval pending without interaction hook: ${approvalId}`);
    this.name = 'ApprovalPendingWithoutInteractionHook';
  }
}

export class InteractionPendingWithoutInteractionHook extends Error {
  constructor(readonly event: InteractionEvent) {
    super(`interaction pending without interaction hook: ${event.interactionId}`);
    this.name = 'InteractionPendingWithoutInteractionHook';
  }
}
