import type { RunRecord, RunStore } from '../runStore.js';

import type { BackgroundTaskMetadata } from './backgroundTaskMetadata.js';

export async function requeueInterruptedAutomationAgent(
  runStore: RunStore | undefined,
  record: RunRecord,
  metadata: BackgroundTaskMetadata | null,
): Promise<boolean> {
  if (
    metadata?.taskType !== 'agent'
    || !metadata.automationFence
    || !metadata.executionChildSessionId
    || !metadata.executionChildRunId
  ) return false;

  const markStatusIfCurrent = runStore?.markStatusIfCurrent?.bind(runStore);
  if (!markStatusIfCurrent) return false;
  // CAS preserves a concurrent cancellation instead of converting it back into executable work.
  await markStatusIfCurrent(record.runId, ['running'], 'pending',
    'background_task_interrupted_replay_ready', { backgroundTaskReady: true, wakeState: 'none' });
  return true;
}
