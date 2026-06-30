import { dirname, join } from 'path';
import type { AppConfig } from '../types/index.js';
import type { AgentRunDispatch } from '../agent/types.js';
import { executeJob as executeCronJob, type ExecutorOptions, type UserStoreLike } from './executor.js';
import { appendRunLog } from './run-log.js';
import { CronService, type CronServiceDeps } from './service.js';
import { loadJobs, resolveStorePath, saveJobs } from './store.js';
import type { GroupStore } from '../data/groups/index.js';
import type { TokenUsageStore } from '../data/usage/store.js';
import type { TenantStore } from '../data/tenants/store.js';

export interface CronRuntime {
  enabled: boolean;
  cronStorePath: string;
  cronRunsDir: string;
  service: CronService | null;
}

export type CronRuntimeConfig = Pick<AppConfig, 'cron' | 'server'>;

export interface CreateCronRuntimeOptions {
  config: CronRuntimeConfig;
  agentCwd: string;
  sharedDir: string;
  processCwd: string;
  runAgent: AgentRunDispatch;
  defaultMaxTurns?: number;
  defaultTimeoutSeconds?: number;
  notify?: CronServiceDeps['notify'];
  onEvent?: CronServiceDeps['onEvent'];
  resolveModel?: ExecutorOptions['resolveModel'];
  groupStore?: GroupStore;
  userStore?: UserStoreLike;
  tenantStore?: TenantStore;
  tokenUsageStore?: TokenUsageStore;
}

export function createCronRuntime(options: CreateCronRuntimeOptions): CronRuntime {
  const {
    config,
    agentCwd,
    sharedDir,
    processCwd,
    runAgent,
    defaultMaxTurns = 10,
    defaultTimeoutSeconds = 1800,
    notify,
  } = options;
  const enabled = config.cron?.enabled !== false;
  const cronStorePath = resolveStorePath(
    config.cron?.store || './data/cron/jobs.json',
    processCwd,
  );
  const cronRunsDir = join(dirname(cronStorePath), 'runs');

  if (!enabled) {
    return {
      enabled,
      cronStorePath,
      cronRunsDir,
      service: null,
    };
  }

  const service = new CronService({
    nowMs: () => Date.now(),
    loadJobs: () => loadJobs({ storePath: cronStorePath }),
    saveJobs: (jobs) => saveJobs(jobs, { storePath: cronStorePath }),
    defaultTimeoutSeconds,
    executeJob: async (job, hooks) => executeCronJob(job, {
      runAgent,
      agentCwd,
      sharedDir,
      defaultMaxTurns,
      defaultTimeoutSeconds,
      timezone: config.server.timezone,
      resolveModel: options.resolveModel,
      userStore: options.userStore,
      tenantStore: options.tenantStore,
      onSessionId: hooks?.onSessionId,
      tokenUsageStore: options.tokenUsageStore,
    }),
    appendRunLog: (entry) => appendRunLog(entry, { runsDir: cronRunsDir }),
    notify,
    onEvent: options.onEvent,
    onSessionCreated: options.groupStore ? async (jobId, jobName, sessionId, owner) => {
      const gs = options.groupStore!;
      const cronGroupId = `cron:${jobId}`;
      const existing = gs.findByCronJobId(jobId);
      if (existing) {
        if (existing.name !== jobName) {
          await gs.update(existing.id, { name: jobName });
        }
        await gs.addSessions(cronGroupId, [sessionId], existing.userId);
      } else if (owner) {
        await gs.create({
          name: jobName,
          kind: 'cron',
          cronJobId: jobId,
          sessionIds: [sessionId],
          userId: owner,
        });
      }
    } : undefined,
  });

  return {
    enabled,
    cronStorePath,
    cronRunsDir,
    service,
  };
}
