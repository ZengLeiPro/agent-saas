import { expect } from 'vitest';

import { DEFAULT_TENANT_ID } from '../data/tenants/types.js';
import type { PgRunStore } from '../runtime/runStore.js';

export async function assertStagedInteractionRecovery(store: PgRunStore): Promise<void> {
  const runId = 'staged-interaction-recovery-run';
  const claim = {
    sessionId: 'session-staged-interaction', interactionId: 'ask-staged-interaction',
    interactionType: 'ask_user', claimId: 'claim-staged-interaction', claimedAt: new Date().toISOString(),
  };
  await store.upsertPending({
    runId, sessionId: claim.sessionId, userId: 'user-1', tenantId: DEFAULT_TENANT_ID, channel: 'web',
  });
  await store.markStatus(runId, 'waiting_user');
  await store.claimPersistedInteractionResume(runId, ['waiting_user'], 'interaction_resume_claimed', {
    persistedInteractionResumeClaim: claim,
    resumeInteraction: { interactionId: claim.interactionId, response: { answers: { q: 'yes' } } },
  });
  await expect(store.listStagedPersistedInteractionResumes()).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ runId, metadata: expect.objectContaining({ schedulerState: 'staged' }) })]),
  );
  await expect(store.activatePersistedInteractionResume(runId, { ...claim, claimId: 'wrong' })).resolves.toBeNull();
  await expect(store.activatePersistedInteractionResume(runId, claim, {
    resumeInteraction: { interactionId: claim.interactionId, response: { answers: { q: 'canonical' } } },
  })).resolves.toMatchObject({
    runId,
    metadata: {
      schedulerState: 'ready',
      resumeInteraction: { interactionId: claim.interactionId, response: { answers: { q: 'canonical' } } },
    },
  });
  await expect(store.listStagedPersistedInteractionResumes()).resolves.not.toEqual(
    expect.arrayContaining([expect.objectContaining({ runId })]),
  );
}
