import type { CronJob } from './types.js';
import { cronLogger } from '../utils/logger.js';

interface CronSessionGroupingDeps {
  onSessionCreated?: (
    jobId: string,
    jobName: string,
    sessionId: string,
    owner?: string,
  ) => Promise<void>;
}

export function createCronSessionGrouper(
  deps: CronSessionGroupingDeps,
  job: Pick<CronJob, 'id' | 'name' | 'owner'>,
): (sessionId: string) => Promise<void> | undefined {
  let groupedSessionId: string | undefined;
  let grouping: Promise<void> | undefined;
  return (sessionId) => {
    if (!deps.onSessionCreated) return undefined;
    if (groupedSessionId === sessionId) return grouping;
    groupedSessionId = sessionId;
    grouping = deps.onSessionCreated(job.id, job.name, sessionId, job.owner).catch((error) => {
      cronLogger.error('Failed to handle onSessionCreated:', error);
    });
    return grouping;
  };
}
