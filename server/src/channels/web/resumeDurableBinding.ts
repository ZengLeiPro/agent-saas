import type { RunLiveness } from '@agent/shared';
import type { RunRecord, RunStore } from '../../runtime/runStore.js';
import { projectRunLiveness } from '../../runtime/runLiveness.js';

export interface ResumeDurableBinding {
  active: boolean;
  runId?: string;
  streamId?: string;
  status?: string;
  liveness?: RunLiveness;
  tenantId?: string;
  accessError?: string;
}

export async function resolveResumeDurableBinding(
  lookup: RunStore['getActiveBySession'],
  tenantId: string,
  sessionId: string,
  resolveTenantId: (run: RunRecord) => string | undefined,
): Promise<ResumeDurableBinding | undefined> {
  if (!lookup) return undefined;
  const activeRun = await lookup(tenantId, sessionId);
  if (!activeRun) return { active: false };
  const resolvedTenantId = resolveTenantId(activeRun);
  const metadataStreamId = activeRun.metadata?.streamId; // durable stream binding, if persisted
  return {
    active: true,
    runId: activeRun.runId,
    streamId: typeof metadataStreamId === 'string' ? metadataStreamId : activeRun.runId,
    status: activeRun.status,
    liveness: projectRunLiveness(activeRun),
    ...(resolvedTenantId ? { tenantId: resolvedTenantId } : { accessError: 'Access denied' }),
  };
}
