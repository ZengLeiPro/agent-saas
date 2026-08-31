import type { AcsOrchestratorConfig } from './config.js';
import type { KubeApi } from './kubeApi.js';
import type { Kubectl } from './kubectl.js';
import { lifecycleStateFromMetadata } from './sandboxLifecyclePolicy.js';
import { SANDBOX_NETWORK_CLEANUP_FINALIZER } from './sandboxDeletion.js';
import {
  BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION,
  brokenSandboxStateReason,
  optionalString,
  pausedConditionLastTransition,
  stringValue,
  type ManagedSandbox,
} from './sandboxState.js';

export const MANAGED_BY_LABEL = 'agent-saas-acs-orchestrator';
export const APP_LABEL = 'agent-saas-coding-hand';
export const WORKSPACE_LABEL = 'agent-saas.kaiyan.net/workspace-id';
export const SANDBOX_SCOPE_LABEL = 'agent-saas.kaiyan.net/sandbox-scope-id';
export const SESSION_LABEL = 'agent-saas.kaiyan.net/session-id';
export const NETWORK_POLICY_MODE_LABEL = 'agent-saas.kaiyan.net/network-policy-mode';
export const WORKSPACE_ANNOTATION = 'agent-saas.kaiyan.net/workspace-id';
export const SANDBOX_SCOPE_ANNOTATION = 'agent-saas.kaiyan.net/sandbox-scope-id';
export const SESSION_ANNOTATION = 'agent-saas.kaiyan.net/session-id';
export const MOUNT_SUBPATH_ANNOTATION = 'agent-saas.kaiyan.net/mount-subpath';
export const CREATED_AT_ANNOTATION = 'agent-saas.kaiyan.net/created-at';
export const LAST_ACTIVE_AT_ANNOTATION = 'agent-saas.kaiyan.net/last-active-at';
export const NETWORK_POLICY_MODE_ANNOTATION = 'agent-saas.kaiyan.net/network-policy-mode';
export const NETWORK_POLICY_DENY_PRIVATE_ANNOTATION = 'agent-saas.kaiyan.net/network-policy-deny-private';

export async function readManagedSandboxes(
  config: AcsOrchestratorConfig,
  kubectl: Kubectl,
  kubeApi?: KubeApi | null,
): Promise<ManagedSandbox[]> {
  const labelSelector = `app.kubernetes.io/managed-by=${MANAGED_BY_LABEL}`;
  let items = await kubeApi?.listSandboxItems(labelSelector) ?? null;
  if (items === null) {
    const result = await kubectl.run([
      'get', config.sandboxKind.toLowerCase(), '-l', labelSelector, '-o', 'json',
    ], { timeoutMs: config.sandboxWaitTimeoutMs });
    if (result.exitCode !== 0) throw new Error(`list managed Sandbox 失败: ${result.stderr || result.stdout}`);
    const body = JSON.parse(result.stdout || '{}') as { items?: Array<Record<string, unknown>> };
    items = body.items ?? [];
  }
  return items.map((item) => managedSandboxFromResource(config, item)).filter((sandbox) => sandbox.name);
}

export function managedSandboxFromResource(
  config: AcsOrchestratorConfig,
  item: Record<string, unknown>,
): ManagedSandbox {
    const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : {};
    const annotations = metadata.annotations && typeof metadata.annotations === 'object' ? metadata.annotations as Record<string, unknown> : {};
    const labels = metadata.labels && typeof metadata.labels === 'object' ? metadata.labels as Record<string, unknown> : {};
    const status = item.status && typeof item.status === 'object' ? item.status as Record<string, unknown> : {};
    const phase = stringValue(status.phase);
    const spec = item.spec && typeof item.spec === 'object' ? item.spec as Record<string, unknown> : {};
    const template = spec.template && typeof spec.template === 'object' ? spec.template as Record<string, unknown> : {};
    const podSpec = template.spec && typeof template.spec === 'object' ? template.spec as Record<string, unknown> : {};
    const containers = Array.isArray(podSpec.containers) ? podSpec.containers : [];
    const primaryContainer = containers.find((candidate): candidate is Record<string, unknown> => (
      Boolean(candidate) && typeof candidate === 'object'
      && (!('name' in candidate) || candidate.name === config.sandboxContainerName)
    ));
    const resources = primaryContainer?.resources && typeof primaryContainer.resources === 'object'
      ? primaryContainer.resources as Record<string, unknown> : {};
    const requests = resources.requests && typeof resources.requests === 'object'
      ? resources.requests as Record<string, unknown> : {};
    const limits = resources.limits && typeof resources.limits === 'object'
      ? resources.limits as Record<string, unknown> : {};
    return {
      name: typeof metadata.name === 'string' ? metadata.name : '',
      workspaceId: stringValue(annotations[WORKSPACE_ANNOTATION]) ?? stringValue(labels[WORKSPACE_LABEL]),
      sessionId: stringValue(annotations[SESSION_ANNOTATION]) ?? stringValue(labels[SESSION_LABEL]),
      sandboxScopeId: stringValue(annotations[SANDBOX_SCOPE_ANNOTATION]) ?? stringValue(labels[SANDBOX_SCOPE_LABEL]),
      mountSubPath: stringValue(annotations[MOUNT_SUBPATH_ANNOTATION]), phase,
      ...optionalString('deletionTimestamp', stringValue(metadata.deletionTimestamp)),
      ...(Array.isArray(metadata.finalizers) && metadata.finalizers.includes(SANDBOX_NETWORK_CLEANUP_FINALIZER)
        ? { networkCleanupFinalizer: true } : {}),
      ...optionalString('brokenReason', brokenSandboxStateReason({ phase, raw: item })),
      ...optionalString('pausedConditionChangedAt', pausedConditionLastTransition(item)),
      createdAt: stringValue(annotations[CREATED_AT_ANNOTATION]) ?? stringValue(metadata.creationTimestamp),
      lastActiveAt: stringValue(annotations[LAST_ACTIVE_AT_ANNOTATION]) ?? stringValue(annotations[CREATED_AT_ANNOTATION]) ?? stringValue(metadata.creationTimestamp),
      backgroundShellProtectedUntil: stringValue(annotations[BACKGROUND_SHELL_PROTECTED_UNTIL_ANNOTATION]),
      ...lifecycleStateFromMetadata(labels, annotations),
      image: primaryContainer ? stringValue(primaryContainer.image) : undefined,
      cpuRequest: stringValue(requests.cpu), cpuLimit: stringValue(limits.cpu),
      memoryRequest: stringValue(requests.memory), memoryLimit: stringValue(limits.memory),
    };
}
