import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import type { OwnedOperation } from './ownedOperations.js';
import type { OwnershipRecord } from './ownershipState.js';
import { OwnershipBlockedError, OwnershipUnavailableError } from './ownershipState.js';
import type { SandboxRunnerInput } from './protocol.js';
import type { SandboxRef } from './sandboxManagerTypes.js';
import type { ToolInvocationResponse } from 'server/runtime/handProtocol.js';
import {
  REMOTE_ATTEMPT_CAPABILITIES, deriveRemoteReceiptKey, parseRemoteReceipt,
  type RemoteAttemptFence, type RemoteAttemptReceipt,
} from './remoteAttemptProtocol.js';
import { OWNED_WAIT_BUDGETS, waitForOwned } from './ownedWait.js';
import { remoteUnknownResponse } from './runnerTransport.js';

export interface RunnerControlIdentity {
  podUid?: string;
  capabilities: readonly string[];
}

export type FencedRunnerInput = SandboxRunnerInput & {
  executionFence: RemoteAttemptFence;
  receiptKey: string;
};

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** A kernel-projected Pod UID and API owner link are both required before dispatch. */
export async function readOwnedPodIdentity(input: {
  kubectl: Kubectl;
  sandboxName: string;
  sandboxUid: string;
  signal?: AbortSignal;
}): Promise<string> {
  const result = await waitForOwned(input.kubectl.run(['get', 'pod', input.sandboxName, '-o', 'json'], {
    timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs, signal: input.signal,
  }), { phase: 'remote_pod_identity', timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs, signal: input.signal });
  if (result.exitCode !== 0 || result.remoteState === 'unknown') throw new OwnershipUnavailableError('Pod identity is unavailable');
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); } catch { throw new OwnershipUnavailableError('Malformed Pod identity'); }
  const metadata = object(raw) && object(raw.metadata) ? raw.metadata : null;
  if (!metadata || typeof metadata.uid !== 'string' || !metadata.uid || metadata.deletionTimestamp
    || !Array.isArray(metadata.ownerReferences)
    || !metadata.ownerReferences.some((owner) => object(owner) && owner.uid === input.sandboxUid)) {
    throw new OwnershipUnavailableError('Pod identity does not belong to the pinned sandbox generation');
  }
  return metadata.uid;
}

/** This probe never starts a daemon, invokes a tool or creates a remote attempt. */
export async function readRunnerControlIdentity(config: AcsOrchestratorConfig, kubectl: Kubectl,
  sandboxName: string, signal?: AbortSignal): Promise<RunnerControlIdentity> {
  const result = await waitForOwned(kubectl.run([
    'exec', sandboxName, '-c', config.sandboxContainerName, '--', '/usr/local/bin/python3', '-I',
    '/app/acs-orchestrator/dist/remote/runner_daemon.py', '--capabilities',
  ], { signal, timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs }), {
    phase: 'runner_capability_probe', timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs, signal,
  });
  if (result.exitCode !== 0 || result.remoteState === 'unknown') throw new OwnershipUnavailableError('Signed attempt control is unavailable');
  let raw: unknown;
  try { raw = JSON.parse(result.stdout); } catch { throw new OwnershipUnavailableError('Malformed runner capability response'); }
  if (!object(raw) || raw.protocolVersion !== 1 || typeof raw.podUid !== 'string' || !raw.podUid
    || !Array.isArray(raw.capabilities) || raw.capabilities.length > 16
    || raw.capabilities.some((item) => typeof item !== 'string' || item.length > 64)) {
    throw new OwnershipUnavailableError('Incompatible runner control response');
  }
  return { podUid: raw.podUid, capabilities: raw.capabilities as string[] };
}

export async function prepareFencedRunnerInput(input: {
  config: AcsOrchestratorConfig;
  kubectl: Kubectl;
  operation: OwnedOperation;
  ref: SandboxRef;
  sandboxUid: string;
  runnerInput: SandboxRunnerInput;
  control?: RunnerControlIdentity;
}): Promise<FencedRunnerInput> {
  const { operation, config } = input;
  if (operation.dispatched || operation.record.remoteFence || operation.controller.signal.aborted
    || ['unknown', 'stop_requested'].includes(operation.record.resource)) {
    throw new OwnershipBlockedError(operation.record.operationId);
  }
  const signal = operation.controller.signal;
  const podUid = await readOwnedPodIdentity({ kubectl: input.kubectl, sandboxName: input.ref.name,
    sandboxUid: input.sandboxUid, signal });
  const control = input.control ?? await readRunnerControlIdentity(config, input.kubectl, input.ref.name, signal);
  if (control.podUid !== podUid || !REMOTE_ATTEMPT_CAPABILITIES.every((capability) => control.capabilities.includes(capability))) {
    throw new OwnershipUnavailableError('The runner cannot provide an authenticated exact-attempt stop receipt');
  }
  const fence: RemoteAttemptFence = {
    protocolVersion: 1, operationId: operation.record.operationId, attemptId: operation.record.attemptId,
    ownerId: operation.record.ownerId, sandboxUid: input.sandboxUid, podUid,
    // A delayed start is not a second execution. Execution has its own full budget.
    startBeforeMs: Date.now() + 60_000,
  };
  const receiptKey = deriveRemoteReceiptKey(config.authToken, fence);
  await operation.bindRemoteFence(fence);
  if (operation.controller.signal.aborted) throw new OwnershipBlockedError(operation.record.operationId);
  return { ...input.runnerInput, executionFence: fence, receiptKey };
}

export function remoteReceiptFromResponse(response: ToolInvocationResponse | undefined): unknown {
  const remote = response?.metadata?.remoteExecution;
  return object(remote) ? remote.receipt : undefined;
}

export function verifyOwnedResponse(config: AcsOrchestratorConfig, record: OwnershipRecord,
  response: ToolInvocationResponse | undefined): RemoteAttemptReceipt | null {
  if (!record.remoteFence || !response) return null;
  const remote = response.metadata?.remoteExecution;
  if (!object(remote)) return null;
  try {
    const receipt = parseRemoteReceipt(remote.receipt, record.remoteFence, deriveRemoteReceiptKey(config.authToken, record.remoteFence));
    return receipt && receipt.resource === remote.state ? receipt : null;
  } catch { return null; }
}

/** Called before terminal publication, lease cleanup and late-receipt recovery. */
export function validateFencedResponse(input: SandboxRunnerInput, response: ToolInvocationResponse): ToolInvocationResponse {
  const fenced = input as Partial<FencedRunnerInput>;
  if (!fenced.executionFence || !fenced.receiptKey) return remoteUnknownResponse('missing_remote_fence');
  const remote = response.metadata?.remoteExecution;
  if (!object(remote)) return remoteUnknownResponse('missing_remote_receipt');
  const receipt = parseRemoteReceipt(remote.receipt, fenced.executionFence, fenced.receiptKey);
  if (!receipt || receipt.resource !== remote.state) return remoteUnknownResponse('invalid_remote_receipt');
  if (!['stopped', 'not_started', 'background_owned'].includes(receipt.resource)) {
    return { ...remoteUnknownResponse('remote_stop_unconfirmed'), metadata: { remoteExecution: remote } };
  }
  return response;
}
