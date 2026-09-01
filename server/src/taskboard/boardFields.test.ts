import { describe, expect, it } from 'vitest';

import { rowToBoard } from './boardFields.js';

describe('rowToBoard integration policy projection', () => {
  it('drops historical featureFlags and CI fallback while projecting workflow v3', () => {
    const now = '2026-08-25T00:00:00.000Z';
    const board = rowToBoard({
      id: 'board-1', owner_user_id: 'owner-1', name: 'Legacy policy', description: null,
      visibility: 'personal', prompt: 'prompt', model: null, stage_models: {}, stage_prompts: {},
      repository: null, version: 1, archived_at: null, created_at: now, updated_at: now,
      integration_policy: {
        schemaVersion: 1, enabled: true, revision: 'legacy', workflowVersion: 2,
        featureFlags: { engineV3: false, compose: false },
        ciPolicy: { requiredChecks: [{ name: 'legacy-ci' }] },
        trigger: { mode: 'manual', allowedRoles: ['owner'] },
        batch: { maxTasks: 10, selection: 'priority_then_ready_at' },
        execution: {
          mergeMethod: 'squash', continueIndependentSources: true, autoResolveConflicts: true,
          maxAutomaticRemediationRounds: 2, maxTransientRetries: 3, requireGreenChecks: true,
          deleteRemoteBranch: false, deploy: false,
        },
      },
    }, 'owner-1');

    expect(board.integrationPolicy).toMatchObject({ workflowVersion: 3 });
    expect(board.integrationPolicy).not.toHaveProperty('featureFlags');
    expect(board.integrationPolicy).not.toHaveProperty('ciPolicy');
  });
});
