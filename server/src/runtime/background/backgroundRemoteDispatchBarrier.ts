import type { RunStore } from '../runStore.js';

/** Last in-process barrier immediately before tenant remote provisioning leaves the process. */
export async function assertBackgroundRemoteDispatchBarrier(
  runStore: RunStore | undefined,
  runId: string,
  signal: AbortSignal,
  identity: { childSessionId: string; childRunId: string },
  activateAutomation: () => Promise<void>,
): Promise<void> {
  const assertNotAborted = () => {
    if (signal.aborted) throw signal.reason ?? new Error('background task aborted before remote dispatch');
  };
  assertNotAborted();
  const marked = await runStore?.markStatus(runId, 'running', 'background_remote_hand_dispatched', {
    executionChildSessionId: identity.childSessionId,
    executionChildRunId: identity.childRunId,
  });
  if (!marked || marked.status !== 'running') {
    throw new Error('background task lost running authority before remote dispatch');
  }
  assertNotAborted();
  // Automation consumes prepared intent only after its transactional DB authority check.
  await activateAutomation();
  assertNotAborted();
}
