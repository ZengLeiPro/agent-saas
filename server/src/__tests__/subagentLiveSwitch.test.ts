import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBuiltinTools } from '../agent/builtinTools.js';
import { AutomationFenceRejectedError } from '../runtime/sessionAutomationRuntimeGuard.js';
import { SUBAGENT_TYPES } from '../runtime/subagent/agentTypes.js';
import { SubagentLimiter } from '../runtime/subagent/subagentLimits.js';
import { runSubagent } from '../runtime/subagent/subagentRunner.js';
import { TextOnlyAdapter } from './helpers/subagentModelAdapters.js';
import { makeFixture, runnerDeps } from './helpers/subagentTestFixture.js';

import { rm } from 'node:fs/promises';

describe('runSubagent live background switch', () => {
  const cleanupDirs = new Set<string>();
  afterEach(async () => {
    for (const dir of cleanupDirs) await rm(dir, { recursive: true, force: true });
    cleanupDirs.clear();
  });

  it.each([
    ['prepared', 1], ['session', 2], ['run', 3], ['lease', 4], ['hand', 5], ['before_active', 5],
  ] as const)('re-checks the fence after %s before the next child stage', async (disableAt, minimumPassedChecks) => {
    const fixture = await makeFixture({ cleanupDirs });
    const adapter = new TextOnlyAdapter();
    let enabled = true;
    let passedChecks = 0;
    const checkpoints: string[] = [];
    const onChildRunCreated = vi.fn();
    await expect(runSubagent({
      ...runnerDeps(fixture), parentProviders: [createBuiltinTools()], agentType: SUBAGENT_TYPES.general,
      request: { description: 'live fence', prompt: 'must not reach the next stage', includeCompanyInfo: false },
      limiter: new SubagentLimiter(), modelAdapterFactory: () => adapter, onChildRunCreated,
      beforeChildSideEffects: () => {
        if (!enabled) throw new AutomationFenceRejectedError('execution_disabled');
        passedChecks += 1;
      },
      lifecycleCheckpoint: checkpoint => {
        checkpoints.push(checkpoint);
        if (checkpoint === disableAt) enabled = false;
      },
    })).rejects.toMatchObject({ reason: 'execution_disabled' });
    expect(passedChecks).toBeGreaterThanOrEqual(minimumPassedChecks);
    expect(checkpoints).toContain(disableAt);
    expect(onChildRunCreated).not.toHaveBeenCalled();
    expect(adapter.requests).toHaveLength(0);
  });

  it('recovers for a new child after reopening and leaves ordinary children unaffected', async () => {
    const fixture = await makeFixture({ cleanupDirs });
    let enabled = false;
    const gated = () => { if (!enabled) throw new AutomationFenceRejectedError('execution_disabled'); };
    const common = {
      ...runnerDeps(fixture), parentProviders: [createBuiltinTools()], agentType: SUBAGENT_TYPES.general,
      request: { description: 'live fence recovery', prompt: 'run after reopen', includeCompanyInfo: false },
      limiter: new SubagentLimiter(), modelAdapterFactory: () => new TextOnlyAdapter(),
    };
    await expect(runSubagent({ ...common, beforeChildSideEffects: gated }))
      .rejects.toMatchObject({ reason: 'execution_disabled' });
    enabled = true;
    await expect(runSubagent({ ...common, beforeChildSideEffects: gated })).resolves.toMatchObject({ status: 'completed' });
    enabled = false;
    await expect(runSubagent(common)).resolves.toMatchObject({ status: 'completed' });
  });
});
