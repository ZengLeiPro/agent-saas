import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import {
  RETENTION_DEADLINE_ANNOTATION,
  TERMINAL_AT_ANNOTATION,
  TERMINAL_OUTCOME_ANNOTATION,
  TERMINAL_STATE_ANNOTATION,
  WORKLOAD_CLASS_LABEL,
  WORKLOAD_DESCRIPTOR_ANNOTATION,
  activeInvocationLeaseAnnotationKey,
  type SandboxLifecycleUpdate,
  type SandboxWorkloadDescriptor,
} from './sandboxLifecyclePolicy.js';
import { BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION } from './sandboxState.js';

async function patchMetadata(
  config: AcsOrchestratorConfig,
  kubectl: Kubectl,
  resourceName: string,
  metadata: Record<string, unknown>,
  errorPrefix: string,
): Promise<void> {
  const result = await kubectl.run([
    'patch', resourceName, '--type=merge', '-p', JSON.stringify({ metadata }),
  ], { timeoutMs: config.sandboxWaitTimeoutMs });
  if (result.exitCode !== 0) throw new Error(`${errorPrefix}: ${result.stderr || result.stdout}`);
}

export async function applyLifecycleUpdate(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string, input: SandboxLifecycleUpdate,
): Promise<void> {
  await patchMetadata(config, kubectl, resourceName, { annotations: {
    [TERMINAL_STATE_ANNOTATION]: input.terminalState,
    [TERMINAL_AT_ANNOTATION]: input.terminalAt,
    [TERMINAL_OUTCOME_ANNOTATION]: input.outcome === undefined ? null : JSON.stringify(input.outcome),
    [RETENTION_DEADLINE_ANNOTATION]: input.retentionDeadline ?? null,
  } }, '更新 Sandbox lifecycle 失败');
}

export async function applyInvocationLease(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string,
  invocationKey: string, leaseUntil?: string,
): Promise<void> {
  const key = activeInvocationLeaseAnnotationKey(invocationKey);
  await patchMetadata(config, kubectl, resourceName, { annotations: {
    [key]: leaseUntil ? JSON.stringify({ invocationKey, until: leaseUntil }) : null,
  } }, '更新 invocation lease 失败');
}

export async function applyWorkloadDescriptor(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string,
  workload: SandboxWorkloadDescriptor,
): Promise<void> {
  await patchMetadata(config, kubectl, resourceName, {
    labels: { [WORKLOAD_CLASS_LABEL]: workload.class },
    annotations: {
      [WORKLOAD_DESCRIPTOR_ANNOTATION]: JSON.stringify(workload),
      [TERMINAL_STATE_ANNOTATION]: null,
      [TERMINAL_AT_ANNOTATION]: null,
      [TERMINAL_OUTCOME_ANNOTATION]: null,
      [RETENTION_DEADLINE_ANNOTATION]: null,
    },
  }, '更新 workload descriptor 失败');
}

export async function applyBackgroundShellProtection(
  config: AcsOrchestratorConfig, kubectl: Kubectl, resourceName: string, protectedUntil?: string,
): Promise<void> {
  await patchMetadata(config, kubectl, resourceName, { annotations: {
    [BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION]: protectedUntil ?? null,
  } }, '更新后台 Shell 生命周期保护失败');
}
