import type { RunStore } from './runStore.js';

export async function claimRuntimeRun(runStore: RunStore | undefined, input: Parameters<RunStore['upsertPending']>[0], requireCreateOnly = false): Promise<boolean> {
  if (!runStore) return true;
  if (!runStore.createPending) {
    if (requireCreateOnly) throw new Error(`Runtime run ${input.runId} requires create-only persistence`);
    await runStore.upsertPending(input); return true;
  }
  const claimed = await runStore.createPending(input);
  if (claimed.created) return true;
  if (claimed.record.sessionId !== input.sessionId)
    throw new Error(`Runtime run ${input.runId} 已绑定其他会话 ${claimed.record.sessionId}`);
  return false;
}
