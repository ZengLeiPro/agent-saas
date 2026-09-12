import type { RunRecord } from '../../runtime/runStore.js';

export function completedBackgroundTaskFixture(resultText: string): RunRecord {
  const now = new Date().toISOString();
  return {
    runId: 'bg-task-1',
    sessionId: 'sub-task-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    sandboxScopeId: 'scope-parent-1',
    status: 'completed',
    model: 'actual-model',
    requestedAt: now,
    updatedAt: now,
    metadata: {
      backgroundTask: true,
      parentRunId: 'parent-run-1',
      parentSessionId: 'parent-session-1',
      topLevelSessionId: 'parent-session-1',
      sandboxScopeId: 'scope-parent-1',
      parentToolCallId: 'tool-call-1',
      description: '调研 <边界>',
      prompt: '执行任务',
      agentType: 'general',
      modelRef: 'group/model',
      includeCompanyInfo: false,
      cwd: '/tmp/workspace',
      workspaceId: 'parent-session-1',
      parentChannel: 'web',
      outputTransactionMode: 'terminal_buffered',
      parentOutputTransactionMode: 'replaceable_draft',
      wakeState: 'pending',
      backgroundResult: {
        status: 'completed',
        text: resultText,
        totalTokens: 10,
        toolUseCount: 1,
        turnCount: 2,
        durationMs: 500,
      },
    },
  };
}
