import type { TaskBoardIntegrationCandidate, TaskBoardIntegrationCandidateRevision } from '../../../shared/src/types/taskboard.js';
import type { AppendCandidateRevisionInput } from './integrationCandidateStore.js';
import type { IntegrationEngineV3, IntegrationEngineV3ExpectedSubject, IntegrationEngineV3Result } from './integrationEngineV3.js';

export type IntegrationV3RequestKind = 'work' | 'review' | 'cleanup' | 'workspace_sync';

export interface IntegrationV3CandidateLease {
  candidateId: string;
  leaseId: string;
}

export interface IntegrationV3RequestLease {
  id: string;
  leaseId: string;
  kind: IntegrationV3RequestKind;
  candidateId: string;
  candidateRevision: number;
  payload: Record<string, unknown>;
}

export interface IntegrationV3WorkerCurrent {
  candidate: TaskBoardIntegrationCandidate;
  revision?: TaskBoardIntegrationCandidateRevision;
}

export interface IntegrationV3WorkerHost {
  claimCandidate(leaseMs: number): Promise<IntegrationV3CandidateLease | undefined>;
  loadCurrent(candidateId: string): Promise<IntegrationV3WorkerCurrent>;
  checkpointCandidate(lease: IntegrationV3CandidateLease, checkpoint: Record<string, unknown>): Promise<void>;
  releaseCandidate(lease: IntegrationV3CandidateLease, error?: string, retryable?: boolean): Promise<void>;
  claimRequest(leaseMs: number): Promise<IntegrationV3RequestLease | undefined>;
  dispatchAgent(request: IntegrationV3RequestLease): Promise<void>;
  syncWorkspace(request: IntegrationV3RequestLease): Promise<void>;
  cleanup(request: IntegrationV3RequestLease): Promise<'completed' | 'skipped-by-policy' | 'disabled' | void>;
  completeRequest(request: IntegrationV3RequestLease, outcome?: 'completed' | 'skipped-by-policy' | 'disabled'): Promise<void>;
  releaseRequest(request: IntegrationV3RequestLease, error: string, retryable: boolean): Promise<void>;
  findRecoverableMergeOperation(candidateId: string, revision: number): Promise<string | undefined>;
  logger?: { info(message: string): void; warn(message: string): void };
}

export interface IntegrationV3ComposeExecutor {
  compose(current: Required<IntegrationV3WorkerCurrent>): Promise<Omit<AppendCandidateRevisionInput, 'expectedVersion' | 'expectedCurrentRevision' | 'nextState'>>;
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
}

/** Durable single-item worker. SQL hosts provide SKIP LOCKED leases; the driver remains pure/mockable. */
export class IntegrationV3Worker {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private running?: Promise<void>;
  private readonly intervalMs: number;
  private readonly leaseMs: number;
  private readonly maxRequestsPerTick: number;

  constructor(private readonly options: IntegrationV3WorkerOptions) {
    this.intervalMs = Math.max(100, options.intervalMs ?? 2_000);
    this.leaseMs = Math.max(this.intervalMs * 3, options.leaseMs ?? 30_000);
    this.maxRequestsPerTick = Math.max(1, options.maxRequestsPerTick ?? 10);
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
    for (let index = 0; index < this.maxRequestsPerTick; index += 1) {
      const request = await this.options.host.claimRequest(this.leaseMs);
      if (!request) break;
      await this.processRequest(request);
    }
    const lease = await this.options.host.claimCandidate(this.leaseMs);
    if (lease) await this.processCandidate(lease);
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
    try {
      let cleanupOutcome: 'completed' | 'skipped-by-policy' | 'disabled' | undefined;
      if (request.kind === 'work' || request.kind === 'review') await this.options.host.dispatchAgent(request);
      else if (request.kind === 'workspace_sync') await this.options.host.syncWorkspace(request);
      else cleanupOutcome = await this.options.host.cleanup(request) ?? 'skipped-by-policy';
      await this.options.host.completeRequest(request, cleanupOutcome);
    } catch (error) {
      await this.options.host.releaseRequest(request, message(error), isRetryable(error));
    }
  }

  private async processCandidate(lease: IntegrationV3CandidateLease): Promise<void> {
    try {
      const current = await this.options.host.loadCurrent(lease.candidateId);
      const engine = this.options.engine ?? await this.options.engineFor?.(current);
      if (!engine) throw new Error('Integration v3 engine is unavailable');
      const expected = expectedSubject(current);
      let result: IntegrationEngineV3Result | undefined;
      switch (current.candidate.state) {
        case 'preparing':
          result = await engine.execute({ type: 'start_compose', candidateId: lease.candidateId, expected });
          break;
        case 'composing': {
          const revision = requireRevision(current);
          try {
            const composed = await this.options.composer.compose({ candidate: current.candidate, revision });
            result = await engine.execute({ type: 'compose_clean', candidateId: lease.candidateId, expected, revision: composed });
          } catch (error) {
            if (error instanceof Error && error.name === 'IntegrationV3ComposeConflictError') {
              result = await engine.execute({ type: 'compose_conflict', candidateId: lease.candidateId, expected, evidence: error.message });
            } else throw error;
          }
          break;
        }
        case 'waiting_checks':
          result = await engine.execute({ type: 'request_review', candidateId: lease.candidateId, expected });
          break;
        case 'needs_work':
          result = await engine.execute({ type: 'request_work', candidateId: lease.candidateId, expected });
          break;
        case 'working': {
          const revision = requireRevision(current);
          const refreshed = await this.options.composer.refreshAfterWork({ candidate: current.candidate, revision });
          if (refreshed) result = await engine.execute({ type: 'subject_refreshed', candidateId: lease.candidateId, expected, revision: refreshed });
          break;
        }
        case 'approved':
          result = await engine.execute({ type: 'merge_approved', candidateId: lease.candidateId, expected, executionId: `integration-v3-worker:${lease.candidateId}:r${current.candidate.currentRevision}` });
          break;
        case 'merging': {
          const operationKey = await this.options.host.findRecoverableMergeOperation(lease.candidateId, current.candidate.currentRevision);
          if (operationKey) result = await engine.execute({ type: 'reconcile_merge', candidateId: lease.candidateId, expected, operationKey });
          break;
        }
        case 'merged':
        case 'canceled':
          result = await engine.execute({ type: 'cleanup', candidateId: lease.candidateId, expected, reason: `candidate_${current.candidate.state}` });
          break;
        default:
          break;
      }
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
      await this.options.host.releaseCandidate(lease, message(error), isRetryable(error));
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
  ]);
  return !deterministic.has(code);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
