import type { TaskBoardExecutionPurpose, TaskBoardTaskKind } from './taskboard';

/**
 * Server-authored classification for the top-level workload that owns an ACS
 * Sandbox scope. Descendant sessions inherit this descriptor verbatim.
 */
export type SandboxWorkloadDescriptor =
  | { kind: 'interactive' }
  | {
      kind: 'taskboard';
      /** Present when the taskboard execution context already exposes the task kind. */
      taskKind?: TaskBoardTaskKind;
      /** Present when the taskboard execution context already exposes the execution purpose. */
      purpose?: TaskBoardExecutionPurpose;
    }
  | { kind: 'cron' }
  | { kind: 'memory' };
