import type { AcsOrchestratorConfig } from './config.js';
import type { Kubectl } from './kubectl.js';
import {
  applyLifecycleUpdate,
  SandboxMutationPreconditionError,
} from './sandboxLifecycleMutations.js';
import {
  ACTIVITY_GENERATION_ANNOTATION,
  RETENTION_DEADLINE_ANNOTATION,
  TERMINAL_AT_ANNOTATION,
  type SandboxLifecycleUpdate,
} from './sandboxLifecyclePolicy.js';
import type { SandboxStatus } from './sandboxState.js';
import { LAST_ACTIVE_AT_ANNOTATION } from './sandboxInventoryReader.js';

interface SandboxLifecycleUpdaterHost {
  config: AcsOrchestratorConfig;
  kubectl: Kubectl;
  name: string;
  resourceName: string;
  getStatus(): Promise<SandboxStatus | null>;
  matchesIdentity(status: SandboxStatus): boolean;
  notFound(message: string): Error;
}

export async function updateSandboxLifecycle(
  host: SandboxLifecycleUpdaterHost,
  input: SandboxLifecycleUpdate,
): Promise<{ name: string; retentionDeadline?: string }> {
  let observedUid: string | undefined;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const status = await host.getStatus();
    if (!status) throw host.notFound(`ACS Sandbox ${host.name} not found`);
    if (!host.matchesIdentity(status)) {
      throw host.notFound('ACS Sandbox lifecycle identity not found');
    }
    const metadata = objectValue(status.raw?.metadata);
    const annotations = objectValue(metadata.annotations);
    const uid = stringValue(metadata.uid);
    const resourceVersion = stringValue(metadata.resourceVersion);
    if (!uid || !resourceVersion) {
      throw new SandboxMutationPreconditionError('Sandbox 缺少 UID/resourceVersion');
    }
    if (observedUid && observedUid !== uid) {
      throw new SandboxMutationPreconditionError('Sandbox 已同名重建，拒绝迟到 lifecycle 更新');
    }
    observedUid ??= uid;
    if (stringValue(metadata.deletionTimestamp)) {
      throw new SandboxMutationPreconditionError('Sandbox 已进入删除流程，拒绝 lifecycle 更新');
    }
    const currentTerminalAt = stringValue(annotations[TERMINAL_AT_ANNOTATION]);
    const lastActiveAt = stringValue(annotations[LAST_ACTIVE_AT_ANNOTATION]);
    const activityGeneration = stringValue(annotations[ACTIVITY_GENERATION_ANNOTATION]) ?? null;
    if ((input.expectedActivityGeneration !== undefined && input.expectedActivityGeneration !== activityGeneration)
      || (input.expectedActivityGeneration === undefined
        && lastActiveAt && Date.parse(lastActiveAt) >= Date.parse(input.terminalAt))
      || (currentTerminalAt && Date.parse(currentTerminalAt) >= Date.parse(input.terminalAt))) {
      const retentionDeadline = stringValue(annotations[RETENTION_DEADLINE_ANNOTATION]);
      return { name: host.name, ...(retentionDeadline ? { retentionDeadline } : {}) };
    }
    try {
      await applyLifecycleUpdate(host.config, host.kubectl, host.resourceName, input, {
        uid, resourceVersion,
      }, annotations);
      return {
        name: host.name,
        ...(input.retentionDeadline ? { retentionDeadline: input.retentionDeadline } : {}),
      };
    } catch (error) {
      if (!(error instanceof SandboxMutationPreconditionError) || attempt === 2) throw error;
    }
  }
  throw new SandboxMutationPreconditionError('Sandbox lifecycle CAS 更新重试耗尽');
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
