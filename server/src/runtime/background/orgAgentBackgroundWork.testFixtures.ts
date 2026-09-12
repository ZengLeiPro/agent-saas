import type { RunRecord } from '../runStore.js';
import { orgAgentChannelFixture } from './orgAgentExecutionContext.testFixtures.js';

export function orgAgentBackgroundRunFixture(sharedReadOnlySubPath: string): RunRecord {
  const now = '2026-09-04T00:00:00.000Z';
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    userId: 'service-user',
    tenantId: 'tenant-1',
    model: 'model-1',
    channel: 'background_task',
    status: 'failed',
    executionTarget: 'server-container',
    requestedAt: now,
    updatedAt: now,
    metadata: {
      backgroundTask: true,
      backgroundTaskType: 'agent',
      subagentAgentId: 'subagent-stable-1',
      subagentContinuationProtocolVersion: 1,
      executionChildSessionId: 'physical-session-1',
      executionChildRunId: 'physical-run-1',
      parentRunId: 'parent-run',
      parentSessionId: 'parent-session',
      parentToolCallId: 'tool-1',
      description: '整理异常',
      prompt: '执行',
      agentType: 'general',
      modelRef: 'models/model-1',
      cwd: '/old-task',
      workspaceId: 'old-workspace',
      workOrderId: 'work-1',
      attemptId: 'attempt-1',
      attemptNo: 1,
      sharedReadOnlySubPath,
      orgAgentChannel: orgAgentChannelFixture,
    },
  };
}
