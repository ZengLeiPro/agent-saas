import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import { deriveRemoteReceiptKey, parseRemoteReceipt, type RemoteAttemptFence, type RemoteAttemptReceipt } from './remoteAttemptProtocol.js';
import { waitForOwned, OWNED_WAIT_BUDGETS } from './ownedWait.js';

/** Short control RPC; no provisioning, new invocation lease or command replay. */
export async function queryRemoteAttempt(input: {
  config: AcsOrchestratorConfig;
  kubectl: Kubectl;
  sandboxName: string;
  fence: RemoteAttemptFence;
  action: 'status' | 'cancel';
}): Promise<RemoteAttemptReceipt | null> {
  return (await queryRemoteAttemptEvidence(input))?.receipt ?? null;
}

export async function queryRemoteAttemptEvidence(input: {
  config: AcsOrchestratorConfig;
  kubectl: Kubectl;
  sandboxName: string;
  fence: RemoteAttemptFence;
  action: 'status' | 'cancel';
}): Promise<{ receipt: RemoteAttemptReceipt; envelope: unknown } | null> {
  const receiptKey = deriveRemoteReceiptKey(input.config.authToken, input.fence);
  const task = input.kubectl.run([
    'exec', '-i', input.sandboxName, '-c', input.config.sandboxContainerName, '--',
    '/usr/local/bin/python3', '-I', '/app/acs-orchestrator/dist/remote/attempt_control.py',
  ], { timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs, input: JSON.stringify({
    protocolVersion: 1, action: input.action, fence: input.fence, receiptKey,
    workspaceRoot: input.config.workspaceMountPath,
  }) });
  const result = await waitForOwned(task, { phase: `remote_attempt_${input.action}`, timeoutMs: OWNED_WAIT_BUDGETS.persistenceMs });
  if (result.exitCode !== 0 || result.remoteState === 'unknown') return null;
  try {
    const value = JSON.parse(result.stdout) as { protocolVersion?: unknown; receipt?: unknown };
    const receipt = value.protocolVersion === 1 ? parseRemoteReceipt(value.receipt, input.fence, receiptKey) : null;
    return receipt ? { receipt, envelope: value.receipt } : null;
  } catch { return null; }
}
