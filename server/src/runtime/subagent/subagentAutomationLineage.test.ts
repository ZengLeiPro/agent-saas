import { describe, expect, it } from 'vitest';
import { automationFenceFromMetadata } from '../automationFence.js';
import { deriveChildAutomationFence } from './subagentRunner.js';

describe('subagent automation lineage', () => {
  it('keeps root execution lineage while fencing side effects with childRunId', () => {
    const fence = deriveChildAutomationFence({
      automationId: 'automation-a',
      incarnationId: 'incarnation-a',
      generation: 7,
      specVersion: 4,
      executionId: 'execution-root',
      runId: 'run-root',
    }, 'run-child', 'session-root');
    expect(fence).toMatchObject({
      automationId: 'automation-a',
      executionId: 'execution-root',
      rootSessionId: 'session-root',
      rootRunId: 'run-root',
      runId: 'run-child',
    });
    expect(deriveChildAutomationFence(fence, 'run-grandchild', 'session-child')).toMatchObject({
      rootSessionId: 'session-root',
      rootRunId: 'run-root',
      runId: 'run-grandchild',
    });
    expect(automationFenceFromMetadata(JSON.parse(JSON.stringify({ automationFence: fence })))).toEqual(fence);
  });
});
