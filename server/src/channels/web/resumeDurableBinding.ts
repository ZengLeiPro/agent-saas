import type { RunRecord, RunStore } from '../../runtime/runStore.js';

export interface ResumeDurableBinding {
  active: boolean;
  runId?: string;
  streamId?: string;
  status?: string;
  tenantId?: string;
  accessError?: string;
}

export async function resolveResumeDurableBinding(
  lookup: RunStore['getActiveBySession'],
  sessionId: string,
  resolveTenantId: (run: RunRecord) => string | undefined,
): Promise<ResumeDurableBinding | undefined> {
  if (!lookup) return undefined;
  const activeRun = await lookup(sessionId);
  if (!activeRun) return { active: false };
  const tenantId = resolveTenantId(activeRun);
  const metadataStreamId = activeRun.metadata?.streamId;
  return {
    active: true,
    runId: activeRun.runId,
    streamId: typeof metadataStreamId === 'string' ? metadataStreamId : activeRun.runId,
    status: activeRun.status,
    ...(tenantId ? { tenantId } : { accessError: 'Access denied' }),
  };
}
