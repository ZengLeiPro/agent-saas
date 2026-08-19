import type {
  TaskBoardExecutionPurpose,
  TaskBoardTaskKind,
} from '../../../shared/src/types/taskboard.js';

export interface TaskboardExecutionSessionDescriptor {
  sessionPrefix: string;
  integrationMetadata: Record<string, unknown>;
}

export function taskboardExecutionSessionDescriptor(
  taskKind: TaskBoardTaskKind | undefined,
  purpose: TaskBoardExecutionPurpose,
  taskId: string,
): TaskboardExecutionSessionDescriptor {
  const integrationAgentRuntime = taskKind === 'integration'
    && (purpose === 'work' || purpose === 'review');
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
