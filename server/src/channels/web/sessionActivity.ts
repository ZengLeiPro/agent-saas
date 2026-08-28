import type { RunRecord, RunStore } from '../../runtime/runStore.js';

export interface ActiveSessionActivity {
  run: RunRecord;
  kind: 'run' | 'dispatcher_background';
}

export async function getActiveSessionActivity(
  runStore: RunStore,
  sessionId: string,
): Promise<ActiveSessionActivity | null> {
  const run = await runStore.getActiveBySession?.(sessionId);
  if (run) return { run, kind: 'run' };
  const background = await runStore.getActiveDispatcherTaskByParentSession?.(sessionId);
  return background ? { run: background, kind: 'dispatcher_background' } : null;
}

export async function getSessionActivityStreamStatus(
  runStore: RunStore,
  sessionId: string,
  findDirectStreamId: () => string | undefined,
): Promise<{ active: boolean; streamId?: string; runId?: string; status?: string }> {
  const activity = await getActiveSessionActivity(runStore, sessionId);
  if (!activity) return { active: false };
  const streamId = activity.kind === 'run'
    ? findDirectStreamId() ?? (typeof activity.run.metadata?.streamId === 'string' ? activity.run.metadata.streamId : undefined)
    : undefined;
  return {
    active: true,
    ...(streamId ? { streamId } : {}),
    runId: activity.run.runId,
    status: activity.run.status,
  };
}
