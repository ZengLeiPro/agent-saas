import type {
  TaskBoardTask,
  TaskBoardTaskPatchInput,
} from '../../../shared/src/types/taskboard.js';
import { TaskboardValidationError } from './types.js';

export function resolveTaskKindMutation(
  task: TaskBoardTask,
  kind: TaskBoardTaskPatchInput['kind'],
): { promoting: boolean; requiredRole: 'editor' | 'maintainer' } {
  if (kind === undefined) return { promoting: false, requiredRole: 'editor' };
  if (task.kind !== 'advisory' || kind !== 'delivery') {
    throw new TaskboardValidationError(
      'Only advisory tasks can be promoted to delivery',
      'TASKBOARD_TASK_KIND_TRANSITION_FORBIDDEN',
    );
  }
  return { promoting: true, requiredRole: 'maintainer' };
}

export function describeTaskUpdate(
  task: TaskBoardTask,
  input: TaskBoardTaskPatchInput,
): { type: string; payload: Record<string, unknown> } {
  const fields = Object.keys(input).filter((key) => key !== 'expectedVersion');
  if (input.kind !== 'delivery') return { type: 'task.updated', payload: { fields } };
  return {
    type: 'task.promoted',
    payload: {
      fields,
      fromKind: task.kind,
      toKind: 'delivery',
      previousStatus: task.status,
      status: 'todo',
    },
  };
}
