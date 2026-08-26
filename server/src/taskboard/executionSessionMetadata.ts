import type {
  TaskBoardExecutionPurpose,
  TaskBoardTaskKind,
} from '../../../shared/src/types/taskboard.js';

export interface TaskboardExecutionSessionDescriptor {
  sessionPrefix: string;
  integrationMetadata: Record<string, unknown>;
}

export function reusableTaskboardSessionId(
  taskKind: TaskBoardTaskKind | undefined,
  purpose: TaskBoardExecutionPurpose,
  executions: Array<{ purpose: TaskBoardExecutionPurpose; sessionId: string }>,
  integrationDurableSessionId?: string,
): string | undefined {
  if (taskKind === 'integration') {
    return purpose === 'review'
      ? undefined
      : integrationDurableSessionId
        ?? executions.find((execution) => execution.purpose === 'work')?.sessionId;
  }
  return purpose === 'work'
    ? executions.find((execution) => execution.purpose === 'work')?.sessionId
    : undefined;
}

export function taskboardExecutionSessionDescriptor(
  taskKind: TaskBoardTaskKind | undefined,
  purpose: TaskBoardExecutionPurpose,
  taskId: string,
): TaskboardExecutionSessionDescriptor {
  const integrationAgentRuntime = taskKind === 'integration';
  return {
    sessionPrefix: integrationAgentRuntime
      ? `taskboard-integration-${purpose}`
      : purpose === 'review'
        ? 'taskboard-review'
        : purpose === 'merge'
          ? 'taskboard-merge'
          : 'taskboard',
    integrationMetadata: integrationAgentRuntime ? {
      taskboardIntegration: true,
      taskboardIntegrationRole: purpose,
      taskboardIntegrationTaskId: taskId,
      taskboardWorkflowVersion: 3,
    } : {},
  };
}
