import { dirname, join } from 'path';
import pg from 'pg';
import type { AppConfig } from '../types/index.js';
import type { AgentRunDispatch } from '../agent/types.js';
import { executeJob as executeCronJob, type ExecutorOptions, type UserStoreLike } from './executor.js';
import { appendRunLog } from './run-log.js';
import { CronService, type CronRunLease, type CronServiceDeps } from './service.js';
import { loadJobs, mutateJobs, resolveStorePath, saveJobs } from './store.js';
import type { GroupStore } from '../data/groups/index.js';
import type { SkillConfigStore } from '../data/skills/store.js';
import type { TokenUsageStore } from '../data/usage/store.js';
import type { TenantStore } from '../data/tenants/store.js';

const { Client } = pg;

async function withPgAdvisoryLock<T>(
  connectionString: string,
  lockName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1)::bigint)', [lockName]);
    return await operation();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [lockName]).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

async function tryAcquirePgRunLease(
  connectionString: string,
  lockName: string,
): Promise<CronRunLease | null> {
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired',
      [lockName],
    );
    if (result.rows[0]?.acquired !== true) {
      await client.end().catch(() => undefined);
      return null;
    }
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      await client.query('SELECT pg_advisory_unlock(hashtext($1)::bigint)', [lockName]).catch(() => undefined);
      await client.end().catch(() => undefined);
    },
  };
}

export interface CronRuntime {
  enabled: boolean;
  cronStorePath: string;
  cronRunsDir: string;
  service: CronService | null;
}

export type CronRuntimeConfig = Pick<AppConfig, 'cron' | 'server' | 'runtimeEventStore'>;

export interface CreateCronRuntimeOptions {
  config: CronRuntimeConfig;
  agentCwd: string;
  sharedDir: string;
  processCwd: string;
  runAgent: AgentRunDispatch;
  defaultMaxTurns?: number;
  defaultTimeoutSeconds?: number;
  defaultModel?: ExecutorOptions['defaultModel'];
  notify?: CronServiceDeps['notify'];
  onEvent?: CronServiceDeps['onEvent'];
  resolveModel?: ExecutorOptions['resolveModel'];
  resolveDefaultModel?: ExecutorOptions['resolveDefaultModel'];
  groupStore?: GroupStore;
  userStore?: UserStoreLike;
  tenantStore?: TenantStore;
  tokenUsageStore?: TokenUsageStore;
  skillConfigStore?: SkillConfigStore;
  skillMaterialization?: ExecutorOptions['skillMaterialization'];
  tenantSkillsRootDir?: string;
  /** memory_poll 系统任务（2026-07-14 批次）：活动预检 + 执行参数 */
  userActivityService?: ExecutorOptions['userActivityService'];
  memoryPoll?: ExecutorOptions['memoryPoll'];
  memoryConsolidationBridge?: ExecutorOptions['memoryConsolidationBridge'];
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
  const pgConfig = config.runtimeEventStore?.backend === 'pg'
    ? config.runtimeEventStore
    : undefined;
  const lockPrefix = pgConfig?.tablePrefix ?? 'agent_saas';
  const withStoreLock = pgConfig
    ? <T>(operation: () => Promise<T>) => withPgAdvisoryLock(
        pgConfig.connectionString,
        `${lockPrefix}:cron-store:${cronStorePath}`,
        operation,
      )
    : undefined;
  const tryAcquireRunLease = pgConfig
    ? (jobId: string) => tryAcquirePgRunLease(
        pgConfig.connectionString,
        `${lockPrefix}:cron-run:${jobId}`,
      )
    : undefined;

  if (!enabled) {
    return {
      enabled,
      cronStorePath,
      cronRunsDir,
      service: null,
    };
  }

  const storeOptions = { storePath: cronStorePath, withLock: withStoreLock };
  const service = new CronService({
    nowMs: () => Date.now(),
    loadJobs: () => loadJobs(storeOptions),
    saveJobs: (jobs) => saveJobs(jobs, storeOptions),
    mutateJobs: (mutator) => mutateJobs(mutator, storeOptions),
    tryAcquireRunLease,
    defaultTimeoutSeconds,
    executeJob: async (job, hooks) => executeCronJob(job, {
      runAgent,
      agentCwd,
      sharedDir,
      defaultMaxTurns,
      defaultTimeoutSeconds,
      defaultModel: options.defaultModel,
      timezone: config.server.timezone,
      resolveModel: options.resolveModel,
      resolveDefaultModel: options.resolveDefaultModel,
      userStore: options.userStore,
      tenantStore: options.tenantStore,
      onSessionId: hooks?.onSessionId,
      tokenUsageStore: options.tokenUsageStore,
      skillConfigStore: options.skillConfigStore,
      skillMaterialization: options.skillMaterialization,
      tenantSkillsRootDir: options.tenantSkillsRootDir,
      userActivityService: options.userActivityService,
      memoryPoll: options.memoryPoll,
      memoryConsolidationBridge: options.memoryConsolidationBridge,
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
