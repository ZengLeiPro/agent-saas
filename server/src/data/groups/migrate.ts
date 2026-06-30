/**
 * One-time migration: backfill cron groups from existing cron run logs.
 *
 * Before this migration, cron groups were computed on-the-fly by the frontend
 * from each session's `cronJobId` field. After the groups-backend migration,
 * groups must exist as explicit records in groups.json.
 *
 * This function scans cron run logs to discover (jobId -> sessionId[]) mappings,
 * then creates any missing cron group records so that historical cron sessions
 * continue to appear grouped in the UI.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GroupStore } from './store.js';
import type { CronService } from '../../cron/service.js';
import { dataLogger } from '../../utils/logger.js';

interface RunLogSessionEntry {
  sessionId?: string;
  jobName?: string;
}

/**
 * Scan cron run log JSONL files and return jobId -> sessionId[] mapping.
 */
async function scanCronRunLogs(runsDir: string): Promise<Map<string, { sessionIds: string[]; jobName: string }>> {
  const result = new Map<string, { sessionIds: string[]; jobName: string }>();

  let files: string[];
  try {
    files = (await fs.readdir(runsDir)).filter(f => f.endsWith('.jsonl'));
  } catch {
    return result;
  }

  for (const file of files) {
    const jobId = file.replace('.jsonl', '');
    const sessionIds: string[] = [];
    let jobName = '';

    try {
      const content = await fs.readFile(path.join(runsDir, file), 'utf-8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as RunLogSessionEntry;
          if (entry.sessionId) {
            sessionIds.push(entry.sessionId);
          }
          if (entry.jobName) {
            jobName = entry.jobName;
          }
        } catch {
          // skip malformed line
        }
      }
    } catch {
      // skip unreadable file
    }

    if (sessionIds.length > 0) {
      // Deduplicate while preserving order
      const seen = new Set<string>();
      const unique = sessionIds.filter(sid => {
        if (seen.has(sid)) return false;
        seen.add(sid);
        return true;
      });
      result.set(jobId, { sessionIds: unique, jobName: jobName || jobId });
    }
  }

  return result;
}

export async function migrateCronGroups(
  groupStore: GroupStore,
  cronService: CronService | null,
  cronRunsDir: string,
): Promise<void> {
  // Skip if already have cron groups (migration already done)
  const existing = groupStore.listAll();
  if (existing.some(g => g.kind === 'cron')) {
    return;
  }

  const runLogData = await scanCronRunLogs(cronRunsDir);
  if (runLogData.size === 0) return;

  // Load cron jobs to get owner info
  const jobOwnerMap = new Map<string, { name: string; owner?: string }>();
  if (cronService) {
    const jobs = await cronService.list({ includeDisabled: true });
    for (const job of jobs) {
      jobOwnerMap.set(job.id, { name: job.name, owner: job.owner });
    }
  }

  const batch: import('./types.js').CreateGroupInput[] = [];
  for (const [jobId, { sessionIds, jobName }] of runLogData) {
    if (groupStore.findByCronJobId(jobId)) continue;

    const jobInfo = jobOwnerMap.get(jobId);
    batch.push({
      name: jobInfo?.name || jobName,
      kind: 'cron',
      cronJobId: jobId,
      sessionIds,
      userId: jobInfo?.owner || 'anonymous',
    });
  }

  if (batch.length > 0) {
    await groupStore.createBatch(batch);
    dataLogger.info(`Migrated ${batch.length} cron group(s) from run logs`);
  }
}
