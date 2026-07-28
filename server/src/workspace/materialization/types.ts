import type { WorkspaceUser } from '../resolver.js';

export type SkillMaterializationReason =
  | 'startup'
  | 'dispatch'
  | 'cron'
  | 'admin'
  | 'workspace_init';

export type SkillMaterializationTaskStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

export type SkillMaterializationBatchStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed';

export interface SkillMaterializationTarget {
  user: WorkspaceUser;
  userCwd: string;
}

export interface SkillMaterializationRequest extends SkillMaterializationTarget {
  reason: SkillMaterializationReason;
  priority?: number;
  requiredSkillIds?: readonly string[];
  /** 跳过快速版本检查，仍会按逐技能摘要做精确 diff，不等于盲目全量覆盖。 */
  force?: boolean;
}

export interface SkillMaterializationTask {
  id: string;
  batchId: string;
  requestKey: string;
  sourceRevision: string;
  user: WorkspaceUser;
  userCwd: string;
  reason: SkillMaterializationReason;
  priority: number;
  requiredSkillIds: string[];
  force: boolean;
  status: SkillMaterializationTaskStatus;
  attempts: number;
  changedSkills: number;
  skippedSkills: number;
  removedSkills: number;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface SkillMaterializationBatch {
  id: string;
  tenantIds: string[];
  status: SkillMaterializationBatchStatus;
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  changedSkills: number;
  skippedSkills: number;
  removedSkills: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export interface SkillMaterializationResult {
  changedSkills: number;
  skippedSkills: number;
  removedSkills: number;
  desiredHash: string;
}

export interface SkillMaterializationStore {
  init(): Promise<void>;
  enqueueBatch(input: {
    requests: Array<SkillMaterializationRequest & {
      requestKey: string;
      sourceRevision: string;
    }>;
  }): Promise<SkillMaterializationBatch>;
  getBatch(batchId: string): Promise<SkillMaterializationBatch | null>;
  getTask(taskId: string): Promise<SkillMaterializationTask | null>;
  claimNext(
    workerId: string,
    leaseSeconds: number,
    sourceRevision: string,
  ): Promise<SkillMaterializationTask | null>;
  runExclusive<T>(workspaceKey: string, work: () => Promise<T>): Promise<T>;
  markSucceeded(taskId: string, workerId: string, result: SkillMaterializationResult): Promise<void>;
  markFailed(taskId: string, workerId: string, error: string): Promise<void>;
  releaseExpiredLeases(): Promise<number>;
  close(): Promise<void>;
}

export interface SkillMaterializationCoordinator {
  enqueue(requests: SkillMaterializationRequest[]): Promise<SkillMaterializationBatch>;
  getBatch(batchId: string): Promise<SkillMaterializationBatch | null>;
  waitForBatch(batchId: string, timeoutMs?: number): Promise<SkillMaterializationBatch>;
  ensureReady(
    username: string | undefined,
    requiredSkillIds?: readonly string[],
    reason?: SkillMaterializationReason,
  ): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}
