import type { SandboxRunnerInput } from './protocol.js';
import type { ToolInvocationResponse } from 'server/runtime/handProtocol.js';
import { parseRemoteReceipt, type RemoteAttemptFence, type RemoteAttemptReceipt } from './remoteAttemptProtocol.js';
import { remoteUnknownResponse } from './runnerTransport.js';

export interface AuthenticatedRunnerInput extends SandboxRunnerInput {
  executionFence: RemoteAttemptFence;
  receiptKey: string;
}

export function responseReceipt(response: ToolInvocationResponse | undefined): unknown {
  const remote = response?.metadata?.remoteExecution;
  return remote && typeof remote === 'object' && !Array.isArray(remote)
    ? (remote as { receipt?: unknown }).receipt : undefined;
}

/** No network or mutation: validate the complete proof at the result boundary. */
export function authenticatedReceipt(input: AuthenticatedRunnerInput,
  response: ToolInvocationResponse | undefined): RemoteAttemptReceipt | null {
  const remote = response?.metadata?.remoteExecution;
  if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return null;
  const value = remote as { state?: unknown; receipt?: unknown };
  const receipt = parseRemoteReceipt(value.receipt, input.executionFence, input.receiptKey);
  return receipt && receipt.resource === value.state ? receipt : null;
}

export function authenticatedRunnerResult(input: AuthenticatedRunnerInput,
  response: ToolInvocationResponse): ToolInvocationResponse {
  const receipt = authenticatedReceipt(input, response);
  if (!receipt) return remoteUnknownResponse('remote_receipt_invalid');
  if (!['stopped', 'not_started', 'background_owned'].includes(receipt.resource)) {
    return { ...remoteUnknownResponse('remote_stop_unconfirmed'), metadata: response.metadata };
  }
  return response;
}
