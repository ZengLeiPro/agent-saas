import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import { parseRemoteReceipt, type RemoteAttemptFence, type RemoteAttemptReceipt } from './remoteAttemptProtocol.js';

/** Short control RPC; no provisioning, new invocation lease or command replay. */
export async function queryRemoteAttempt(input: {
  config: AcsOrchestratorConfig;
  kubectl: Kubectl;
  sandboxName: string;
  fence: RemoteAttemptFence;
  action: 'status' | 'cancel';
}): Promise<RemoteAttemptReceipt | null> {
  const result = await input.kubectl.run([
    'exec', '-i', input.sandboxName, '-c', input.config.sandboxContainerName, '--',
    'python3', '/app/acs-orchestrator/dist/remote/attempt_control.py',
  ], { timeoutMs: 10_000, input: JSON.stringify({
    action: input.action, fence: input.fence, workspaceRoot: input.config.workspaceMountPath,
  }) });
  if (result.exitCode !== 0 || result.remoteState === 'unknown') return null;
  try {
    const value = JSON.parse(result.stdout) as { protocolVersion?: unknown; receipt?: unknown };
    return value.protocolVersion === 1 ? parseRemoteReceipt(value.receipt, input.fence) : null;
  } catch { return null; }
}
