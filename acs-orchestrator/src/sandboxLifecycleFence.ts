import { SandboxNotFoundError, type SandboxManager } from './sandboxManager.js';
import type { SandboxLifecycleIdentity } from './sandboxLifecyclePolicy.js';
import { ACTIVITY_GENERATION_ANNOTATION } from './sandboxLifecyclePolicy.js';

export async function readSandboxLifecycleFence(
  manager: SandboxManager,
  input: SandboxLifecycleIdentity,
): Promise<{ activityGeneration: string | null }> {
  const ref = manager.ref(input); const status = await manager.getStatus(ref.name);
  if (!status) throw new SandboxNotFoundError(`ACS Sandbox ${ref.name} not found`);
  const actual = manager.refFromStatus(ref.name, status);
  if (actual.workspaceId !== input.workspaceId || actual.sessionId !== input.sessionId
    || actual.sandboxScopeId !== input.sandboxScopeId) {
    throw new SandboxNotFoundError('ACS Sandbox lifecycle identity not found');
  }
  const metadata = status.raw?.metadata as Record<string, unknown> | undefined;
  const annotations = metadata?.annotations as Record<string, unknown> | undefined;
  const generation = annotations?.[ACTIVITY_GENERATION_ANNOTATION];
  return { activityGeneration: typeof generation === 'string' && generation ? generation : null };
}
