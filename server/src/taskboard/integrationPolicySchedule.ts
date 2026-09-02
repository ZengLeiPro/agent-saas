import type { TaskBoardIntegrationPolicy } from '../../../shared/src/types/taskboard.js';
import { computeNextRunAtMs } from '../cron/scheduler.js';
import { TaskboardValidationError } from './types.js';

export function integrationPolicyNextRunAt(
  policy: TaskBoardIntegrationPolicy | undefined,
  nowMs = Date.now(),
): Date | null {
  if (!policy?.enabled || policy.trigger.mode !== 'scheduled') return null;
  const nextRunAt = computeNextRunAtMs({
    kind: 'cron',
    expr: policy.trigger.cron,
    tz: policy.trigger.timezone,
  }, nowMs);
  if (!nextRunAt) {
    throw new TaskboardValidationError(
      'Integration schedule cron or timezone is invalid',
      'TASKBOARD_INTEGRATION_SCHEDULE_INVALID',
    );
  }
  return new Date(nextRunAt);
}
