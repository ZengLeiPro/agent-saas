import type { TaskBoardIntegrationCandidate, TaskBoardIntegrationCandidateRevision } from '../../../shared/src/types/taskboard.js';
import type { AppendCandidateRevisionInput } from './integrationCandidateStore.js';
import type { IntegrationEngineV3, IntegrationEngineV3ExpectedSubject, IntegrationEngineV3Result } from './integrationEngineV3.js';
import { IntegrationV3CandidateReloadRequiredError, IntegrationV3ComposeConflictError } from './integrationV3ComposeExecutor.js';
import { RepositoryWorkspaceSyncError } from './repositoryWorkspaceSync.js';

export type IntegrationV3RequestKind = 'work' | 'review' | 'cleanup' | 'workspace_sync';

export interface IntegrationV3CandidateLease {
  candidateId: string;
  leaseId: string;
  /** Monotonic fencing token. A new claim always advances it. */
  leaseEpoch: string;
  releaseIdentity: string;
}

export interface IntegrationV3LeaseGuard {
  lease: IntegrationV3CandidateLease;
  assertCurrent(): Promise<void>;
}

export interface IntegrationV3RequestLease {
  id: string;
  leaseId: string;
  kind: IntegrationV3RequestKind;
  candidateId: string;
  candidateRevision: number;
  payload: Record<string, unknown>;
}

export interface IntegrationV3RequestLeaseGuard {
  request: IntegrationV3RequestLease;
  assertCurrent(): Promise<void>;
}

export interface IntegrationV3WorkerCurrent {
  candidate: TaskBoardIntegrationCandidate;
  revision?: TaskBoardIntegrationCandidateRevision;
}

export type IntegrationV3CleanupActionStatus = 'succeeded' | 'skipped' | 'failed';

export interface IntegrationV3CleanupActionReceipt {
  action: 'revoke_capabilities' | 'fence_capabilities' | 'terminalize_prepared_operations' | 'remove_candidate_worktree' | 'source_pull_request';
  status: IntegrationV3CleanupActionStatus;
  target?: string;
  reason?: string;
  error?: string;
}

/** Durable evidence for every cleanup side effect. Skips must name the policy reason. */
export interface IntegrationV3CleanupReceipt {
  version: 1;
  outcome: 'succeeded' | 'failed';
  actions: IntegrationV3CleanupActionReceipt[];
  completedAt: string;
}

export interface IntegrationV3RecoverableMergeOperation {
  operationKey: string;
  state: 'prepared' | 'executing' | 'unknown' | 'failed' | 'needs_human' | 'succeeded';
}

export interface IntegrationV3WorkerHost {
  claimCandidate(leaseMs: number): Promise<IntegrationV3CandidateLease | undefined>;
  renewCandidate(lease: IntegrationV3CandidateLease, leaseMs: number): Promise<void>;
  assertCandidateLease(lease: IntegrationV3CandidateLease): Promise<void>;
  loadCurrent(candidateId: string): Promise<IntegrationV3WorkerCurrent>;
  checkpointCandidate(lease: IntegrationV3CandidateLease, checkpoint: Record<string, unknown>): Promise<void>;
  releaseCandidate(lease: IntegrationV3CandidateLease, error?: string, retryable?: boolean, evidence?: Record<string, unknown>): Promise<void>;
  claimRequest(leaseMs: number): Promise<IntegrationV3RequestLease | undefined>;
  renewRequest(request: IntegrationV3RequestLease, leaseMs: number): Promise<void>;
  assertRequestLease(request: IntegrationV3RequestLease): Promise<void>;
  dispatchAgent(request: IntegrationV3RequestLease, guard: IntegrationV3RequestLeaseGuard): Promise<void>;
  syncWorkspace(request: IntegrationV3RequestLease, guard: IntegrationV3RequestLeaseGuard): Promise<void>;
  cleanup(request: IntegrationV3RequestLease, guard: IntegrationV3RequestLeaseGuard): Promise<IntegrationV3CleanupReceipt | void>;
  completeRequest(request: IntegrationV3RequestLease, receipt?: IntegrationV3CleanupReceipt): Promise<void>;
  releaseRequest(request: IntegrationV3RequestLease, error: string, retryable: boolean): Promise<void>;
  findRecoverableMergeOperation(candidateId: string, revision: number): Promise<IntegrationV3RecoverableMergeOperation | undefined>;
  logger?: { info(message: string): void; warn(message: string): void };
}

export interface IntegrationV3ComposeExecutor {
  /** Produces only the deterministic local subject. The Worker persists it before publication. */
  compose(current: Required<IntegrationV3WorkerCurrent>, guard: IntegrationV3LeaseGuard): Promise<Omit<AppendCandidateRevisionInput, 'expectedVersion' | 'expectedCurrentRevision' | 'nextState'>>;
  /** Publishes and reconciles an already persisted provider_subject revision. */
  publish(current: Required<IntegrationV3WorkerCurrent>, guard: IntegrationV3LeaseGuard): Promise<void>;
  refreshAfterWork(current: Required<IntegrationV3WorkerCurrent>): Promise<Omit<AppendCandidateRevisionInput, 'expectedVersion' | 'expectedCurrentRevision' | 'nextState'> | undefined>;
}

export interface IntegrationV3WorkerOptions {
  host: IntegrationV3WorkerHost;
  engine?: IntegrationEngineV3;
  engineFor?: (current: IntegrationV3WorkerCurrent) => Promise<IntegrationEngineV3>;
  composer: IntegrationV3ComposeExecutor;
  intervalMs?: number;
  leaseMs?: number;
  maxRequestsPerTick?: number;
  maxActiveTickMs?: number;
}

/** Durable single-item worker. SQL hosts provide SKIP LOCKED leases; the driver remains pure/mockable. */
export class IntegrationV3Worker {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private running?: Promise<void>;
  private lastSuccessfulTickAt?: number;
  private activeTickStartedAt?: number;
  private lastTickError?: string;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly maxRequestsPerTick: number;
  private readonly maxActiveTickMs: number;

  constructor(private readonly options: IntegrationV3WorkerOptions) {
    this.intervalMs = Math.max(100, options.intervalMs ?? 2_000);
    this.leaseMs = Math.max(this.intervalMs * 3, options.leaseMs ?? 30_000);
    this.maxRequestsPerTick = Math.max(1, options.maxRequestsPerTick ?? 10);
    this.maxActiveTickMs = Math.max(this.leaseMs, options.maxActiveTickMs ?? 300_000);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async runOnce(): Promise<void> {
    this.activeTickStartedAt = Date.now();
    try {
      for (let index = 0; index < this.maxRequestsPerTick; index += 1) {
        const request = await this.options.host.claimRequest(this.leaseMs);
        if (!request) break;
        await this.processRequest(request);
      }
      const lease = await this.options.host.claimCandidate(this.leaseMs);
      if (lease) await this.processCandidate(lease);
      this.lastSuccessfulTickAt = Date.now();
      this.lastTickError = undefined;
    } catch (error) {
      this.lastTickError = message(error);
      throw error;
    } finally {
      this.activeTickStartedAt = undefined;
    }
  }

  health(now = Date.now()): { healthy: boolean; reason?: string } {
    if (this.lastTickError) return { healthy: false, reason: 'worker_tick_failed' };
    if (this.lastSuccessfulTickAt === undefined) return { healthy: false, reason: 'worker_tick_pending' };
    if (now - this.lastSuccessfulTickAt > Math.max(this.intervalMs * 3, 10_000)) {
      if (this.activeTickStartedAt !== undefined && now - this.activeTickStartedAt <= this.maxActiveTickMs) {
        return { healthy: true };
      }
      return { healthy: false, reason: 'worker_tick_stale' };
    }
    return { healthy: true };
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.runOnce().catch((error) => {
        this.options.host.logger?.warn(`Integration v3 worker tick failed: ${message(error)}`);
      }).finally(() => {
        this.running = undefined;
        this.schedule(this.intervalMs);
      });
    }, delay);
    this.timer.unref?.();
  }

  private async processRequest(request: IntegrationV3RequestLease): Promise<void> {
    let lost: unknown;
    let renewing = false;
    const renew = async () => {
      if (renewing || lost) return;
      renewing = true;
      try { await this.options.host.renewRequest(request, this.leaseMs); }
      catch (error) { lost = error; }
      finally { renewing = false; }
    };
    const timer = setInterval(() => { void renew(); }, Math.max(10, Math.floor(this.leaseMs / 3)));
    timer.unref?.();
    const guard: IntegrationV3RequestLeaseGuard = {
      request,
      assertCurrent: async () => {
        if (lost) throw lost;
        await this.options.host.assertRequestLease(request);
        if (lost) throw lost;
      },
    };
    try {
      await guard.assertCurrent();
      let cleanupReceipt: IntegrationV3CleanupReceipt | undefined;
      if (request.kind === 'work' || request.kind === 'review') await this.options.host.dispatchAgent(request, guard);
      else if (request.kind === 'workspace_sync') await this.options.host.syncWorkspace(request, guard);
      else {
        cleanupReceipt = await this.options.host.cleanup(request, guard) || undefined;
        if (!cleanupReceipt) throw new Error('Cleanup host returned no action receipt');
        assertCleanupReceipt(cleanupReceipt);
      }
      await guard.assertCurrent();
      await this.options.host.completeRequest(request, cleanupReceipt);
    } catch (error) {
      await this.options.host.releaseRequest(request, message(error), isRetryable(error));
    } finally {
      clearInterval(timer);
    }
  }

  private async processCandidate(lease: IntegrationV3CandidateLease): Promise<void> {
    let lost: unknown;
    let renewing = false;
    const renew = async () => {
      if (renewing || lost) return;
      renewing = true;
      try { await this.options.host.renewCandidate(lease, this.leaseMs); }
      catch (error) { lost = error; }
      finally { renewing = false; }
    };
    const timer = setInterval(() => { void renew(); }, Math.max(10, Math.floor(this.leaseMs / 3)));
    timer.unref?.();
    const guard: IntegrationV3LeaseGuard = {
      lease,
      assertCurrent: async () => {
        if (lost) throw lost;
        await this.options.host.assertCandidateLease(lease);
        if (lost) throw lost;
      },
    };
    try {
      await guard.assertCurrent();
      const current = await this.options.host.loadCurrent(lease.candidateId);
      const engine = this.options.engine ?? await this.options.engineFor?.(current);
      if (!engine) throw new Error('Integration v3 engine is unavailable');
      const expected = expectedSubject(current);
      let result: IntegrationEngineV3Result | undefined;
      const execute = async (command: Parameters<IntegrationEngineV3['execute']>[0]) => {
        await guard.assertCurrent();
        return engine.execute({
          ...command,
          workerBinding: { mutationFence: lease, assertCurrent: guard.assertCurrent },
        });
      };
      switch (current.candidate.state) {
        case 'preparing':
          result = await execute({ type: 'start_compose', candidateId: lease.candidateId, expected });
          break;
        case 'composing': {
          const revision = requireRevision(current);
          if (revision.subjectKind === 'provider_subject') {
            await this.options.composer.publish({ candidate: current.candidate, revision }, guard);
            result = await execute({
              type: 'publish_complete', candidateId: lease.candidateId, expected,
              ...(current.candidate.lastError ? { evidence: current.candidate.lastError } : {}),
            });
          } else {
            try {
              const composed = await this.options.composer.compose({ candidate: current.candidate, revision }, guard);
              result = await execute({ type: 'compose_persisted', candidateId: lease.candidateId, expected, revision: composed });
            } catch (error) {
              if (error instanceof IntegrationV3ComposeConflictError) {
                result = await execute({
                  type: 'compose_persisted', candidateId: lease.candidateId, expected,
                  evidence: error.message, revision: error.revision,
                });
              } else throw error;
            }
          }
          break;
        }
        case 'waiting_checks':
          result = await execute({ type: 'request_review', candidateId: lease.candidateId, expected });
          break;
        case 'needs_work':
          result = await execute({ type: 'request_work', candidateId: lease.candidateId, expected });
          break;
        case 'working': {
          result = await execute({ type: 'request_work', candidateId: lease.candidateId, expected });
          const revision = requireRevision(current);
          try {
            const refreshed = await this.options.composer.refreshAfterWork({ candidate: current.candidate, revision });
            if (refreshed) result = await execute({ type: 'subject_refreshed', candidateId: lease.candidateId, expected, revision: refreshed });
          } catch (error) {
            if (error instanceof Error && error.name === 'IntegrationV3InvalidWorkResultError') {
              result = await execute({ type: 'needs_human', candidateId: lease.candidateId, expected, reason: error.message });
            } else throw error;
          }
          break;
        }
        case 'in_review':
          result = await execute({ type: 'request_review', candidateId: lease.candidateId, expected });
          break;
        case 'approved':
          result = await execute({ type: 'merge_approved', candidateId: lease.candidateId, expected, executionId: `integration-v3-worker:${lease.candidateId}:r${current.candidate.currentRevision}` });
          break;
        case 'merging': {
          const operation = await this.options.host.findRecoverableMergeOperation(
            lease.candidateId,
            current.candidate.currentRevision,
          );
          if (operation?.state === 'prepared') {
            result = await execute({
              type: 'merge_approved',
              candidateId: lease.candidateId,
              expected,
              executionId: `integration-v3-worker:${lease.candidateId}:r${current.candidate.currentRevision}`,
            });
          } else if (operation) {
            result = await execute({
              type: 'reconcile_merge',
              candidateId: lease.candidateId,
              expected,
              operationKey: operation.operationKey,
            });
          }
          break;
        }
        case 'needs_human': {
          const operation = await this.options.host.findRecoverableMergeOperation(
            lease.candidateId,
            current.candidate.currentRevision,
          );
          if (operation?.state === 'succeeded') {
            result = await execute({
              type: 'reconcile_merge',
              candidateId: lease.candidateId,
              expected,
              operationKey: operation.operationKey,
            });
          }
          break;
        }
        case 'merged':
        case 'canceled':
          result = await execute({ type: 'cleanup', candidateId: lease.candidateId, expected, reason: `candidate_${current.candidate.state}` });
          break;
        default:
          break;
      }
      await guard.assertCurrent();
      await this.options.host.checkpointCandidate(lease, {
        state: result?.candidate.state ?? current.candidate.state,
        revision: result?.candidate.currentRevision ?? current.candidate.currentRevision,
        status: result?.status ?? 'idle',
        at: new Date().toISOString(),
      });
      if (result?.status === 'provider_unknown') {
        await this.options.host.releaseCandidate(lease, 'Provider outcome awaits durable reconciliation', true);
      } else {
        await this.options.host.releaseCandidate(lease);
      }
    } catch (error) {
      if (error instanceof IntegrationV3CandidateReloadRequiredError) {
        await this.options.host.releaseCandidate(lease);
        return;
      }
      await this.options.host.releaseCandidate(lease, boundedMessage(error), isRetryable(error), failureEvidence(error, lease));
    } finally {
      clearInterval(timer);
    }
  }
}

export function expectedSubject(current: IntegrationV3WorkerCurrent): IntegrationEngineV3ExpectedSubject {
  const candidate = current.candidate;
  const revision = current.revision;
  return {
    candidateVersion: candidate.version,
    candidateRevision: candidate.currentRevision,
    workflowEpoch: candidate.workflowEpoch,
    laneEpoch: candidate.laneEpoch,
    repositoryId: candidate.repositoryId,
    policyRevision: candidate.policyRevision,
    ...(revision ? {
      baseOid: revision.baseOid,
      headOid: revision.headOid,
      treeOid: revision.treeOid,
      compositionComplete: revision.compositionComplete,
      sourceSetDigest: revision.sourceSetDigest,
      policySnapshotDigest: revision.policySnapshotDigest,
      subjectDigest: revision.subjectDigest,
    } : {}),
  };
}

function requireRevision(current: IntegrationV3WorkerCurrent): TaskBoardIntegrationCandidateRevision {
  if (!current.revision) throw new Error('Current candidate revision is unavailable');
  return current.revision;
}

function isRetryable(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error) return (error as { retryable?: unknown }).retryable !== false;
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
  const deterministic = new Set([
    'TASKBOARD_INTEGRATION_PROVIDER_UNSUPPORTED',
    'TASKBOARD_INTEGRATION_SUBJECT_DRIFT',
    'TASKBOARD_CANDIDATE_APPROVAL_STALE',
    'TASKBOARD_CANDIDATE_SOURCE_OWNERSHIP_MISMATCH',
    'TASKBOARD_CANDIDATE_SOURCE_REPOSITORY_MISMATCH',
    'TASKBOARD_CANDIDATE_TRANSITION_INVALID',
    'WORKTREE_UNKNOWN',
    'WORKTREE_DIRTY',
    'WORKTREE_DIVERGED',
    'MIRROR_UNSAFE',
    'INVALID_PATH',
    'INVALID_REF',
  ]);
  return !deterministic.has(code);
}
function assertCleanupReceipt(receipt: IntegrationV3CleanupReceipt): void {
  const required = ['revoke_capabilities', 'fence_capabilities', 'terminalize_prepared_operations', 'remove_candidate_worktree'] as const;
  for (const action of required) {
    if (!receipt.actions.some((item) => item.action === action)) throw new Error(`Cleanup receipt missing action: ${action}`);
  }
  for (const item of receipt.actions) {
    if (item.status === 'skipped' && !item.reason) throw new Error(`Cleanup skip missing policy reason: ${item.action}`);
    if (item.status === 'failed' && !item.error) throw new Error(`Cleanup failure missing error: ${item.action}`);
  }
  const expected = receipt.actions.some((item) => item.status === 'failed') ? 'failed' : 'succeeded';
  if (receipt.outcome !== expected) throw new Error('Cleanup receipt outcome does not match actions');
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function boundedMessage(error: unknown): string { return message(error).replace(/[\r\n\t]+/g, ' ').slice(0, 2_000); }
function failureEvidence(error: unknown, lease: IntegrationV3CandidateLease): Record<string, unknown> {
  const workspace = error instanceof RepositoryWorkspaceSyncError ? error.evidence : undefined;
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    lease: { id: lease.leaseId, epoch: lease.leaseEpoch, releaseIdentity: lease.releaseIdentity },
    error: { name: error instanceof Error ? error.name : 'Error', code: errorCode(error), message: boundedMessage(error) },
    ...(workspace ? { workspace } : {}),
  };
}
function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}
