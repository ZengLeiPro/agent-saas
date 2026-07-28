import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import type { SkillConfigStore } from '../../data/skills/store.js';
import { serverLogger } from '../../utils/logger.js';
import type { WorkspaceUser } from '../resolver.js';
import { SkillWorkspaceMaterializer } from './materializer.js';
import type {
  SkillMaterializationBatch,
  SkillMaterializationCoordinator,
  SkillMaterializationReason,
  SkillMaterializationRequest,
  SkillMaterializationStore,
  SkillMaterializationTarget,
} from './types.js';

export interface SkillMaterializationServiceOptions {
  store: SkillMaterializationStore;
  materializer: SkillWorkspaceMaterializer;
  skillConfigStore: SkillConfigStore;
  sourceRevision: string;
  resolveTargetByUsername: (username: string) => SkillMaterializationTarget | undefined;
  pollIntervalMs?: number;
  leaseSeconds?: number;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SkillMaterializationService implements SkillMaterializationCoordinator {
  private readonly logger = serverLogger.child('SkillMaterializationService');
  private readonly workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private readonly pollIntervalMs: number;
  private readonly leaseSeconds: number;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly forceRefreshedBatches = new Set<string>();

  constructor(private readonly options: SkillMaterializationServiceOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.leaseSeconds = options.leaseSeconds ?? 3_600;
  }

  async enqueue(requests: SkillMaterializationRequest[]): Promise<SkillMaterializationBatch> {
    const effective: Array<SkillMaterializationRequest & {
      requestKey: string;
      sourceRevision: string;
    }> = [];
    for (const request of requests) {
      if (
        request.force !== true
        && await this.options.materializer.isReadyForUser(
          request.user,
          request.userCwd,
          request.requiredSkillIds ?? [],
        )
      ) {
        continue;
      }
      const required = [...new Set(request.requiredSkillIds ?? [])].sort();
      effective.push({
        ...request,
        requiredSkillIds: required,
        sourceRevision: this.options.sourceRevision,
        requestKey: [
          request.user.id,
          this.options.skillConfigStore.getConfigVersion(),
          required.join(','),
        ].join(':'),
      });
    }
    const batch = await this.options.store.enqueueBatch({ requests: effective });
    this.kick();
    return batch;
  }

  getBatch(batchId: string): Promise<SkillMaterializationBatch | null> {
    return this.options.store.getBatch(batchId);
  }

  async waitForBatch(batchId: string, timeoutMs = 15 * 60_000): Promise<SkillMaterializationBatch> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const batch = await this.options.store.getBatch(batchId);
      if (!batch) throw new Error(`技能物化任务不存在：${batchId}`);
      if (batch.status === 'succeeded' || batch.status === 'partial' || batch.status === 'failed') {
        return batch;
      }
      if (Date.now() >= deadline) {
        throw new Error(`等待技能物化超时：${batchId}`);
      }
      await wait(Math.min(this.pollIntervalMs, 250));
    }
  }

  async ensureReady(
    username: string | undefined,
    requiredSkillIds: readonly string[] = [],
    reason: SkillMaterializationReason = 'dispatch',
  ): Promise<void> {
    if (!username) return;
    const target = this.options.resolveTargetByUsername(username);
    if (!target) throw new Error(`无法解析技能物化用户：${username}`);
    if (await this.options.materializer.isReadyForUser(
      target.user,
      target.userCwd,
      requiredSkillIds,
    )) return;
    const batch = await this.enqueue([{
      ...target,
      reason,
      priority: reason === 'dispatch' || reason === 'cron' ? 100 : 50,
      requiredSkillIds,
    }]);
    const completed = await this.waitForBatch(batch.id);
    if (completed.status !== 'succeeded') {
      throw new Error(completed.error || `技能物化失败：${username}`);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.options.store.releaseExpiredLeases().catch((err) => {
      this.logger.warn(`Release expired skill materialization leases failed: ${this.errorMessage(err)}`);
    });
    this.pollTimer = setInterval(() => this.kick(), this.pollIntervalMs);
    this.pollTimer.unref?.();
    this.kick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await this.loopPromise;
  }

  private kick(): void {
    if (!this.running || this.loopPromise) return;
    this.loopPromise = this.runLoop()
      .catch((err) => {
        this.logger.error('Skill materialization worker loop failed', err);
      })
      .finally(() => {
        this.loopPromise = null;
      });
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const task = await this.options.store.claimNext(
        this.workerId,
        this.leaseSeconds,
        this.options.sourceRevision,
      );
      if (!task) return;
      let lastError: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const result = await this.options.store.runExclusive(task.userCwd, async () => {
            // 获取跨 release workspace 锁后必须重查：可能已有更新 release 先完成，
            // 旧 release 此时应直接成功退出，绝不能倒灌旧技能内容。
            const ready = await this.options.materializer.isReadyForUser(
              task.user,
              task.userCwd,
              task.requiredSkillIds,
            );
            if (
              (!task.force && ready)
              || (task.force && await this.options.materializer.isSuperseded(task.userCwd))
            ) {
              return {
                changedSkills: 0,
                skippedSkills: 0,
                removedSkills: 0,
                desiredHash: 'already-ready',
              };
            }
            const refreshSources = task.force && !this.forceRefreshedBatches.has(task.batchId);
            if (refreshSources) this.forceRefreshedBatches.add(task.batchId);
            return this.options.materializer.materialize({
              taskId: task.id,
              user: task.user,
              userCwd: task.userCwd,
              requiredSkillIds: task.requiredSkillIds,
              forceSourceRefresh: refreshSources,
            });
          });
          await this.options.store.markSucceeded(task.id, this.workerId, result);
          await this.clearForceRefreshMarkerIfFinished(task.batchId);
          lastError = undefined;
          break;
        } catch (err) {
          lastError = err;
          if (attempt < 3) {
            this.logger.warn(
              `Skill materialization retry ${attempt}/3 for ${task.user.username}: ${this.errorMessage(err)}`,
            );
            await wait(attempt * 250);
          }
        }
      }
      if (lastError !== undefined) {
        const message = this.errorMessage(lastError);
        this.logger.warn(`Skill materialization failed for ${task.user.username}: ${message}`);
        await this.options.store.markFailed(task.id, this.workerId, message);
        await this.clearForceRefreshMarkerIfFinished(task.batchId);
      }
    }
  }

  private async clearForceRefreshMarkerIfFinished(batchId: string): Promise<void> {
    if (!this.forceRefreshedBatches.has(batchId)) return;
    try {
      const batch = await this.options.store.getBatch(batchId);
      if (
        batch?.status === 'succeeded'
        || batch?.status === 'partial'
        || batch?.status === 'failed'
      ) {
        this.forceRefreshedBatches.delete(batchId);
      }
    } catch (err) {
      this.logger.warn(
        `Skill materialization batch cleanup failed for ${batchId}: ${this.errorMessage(err)}`,
      );
    }
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

export function buildSkillMaterializationTarget(
  user: WorkspaceUser,
  userCwd: string,
): SkillMaterializationTarget {
  return { user, userCwd };
}
