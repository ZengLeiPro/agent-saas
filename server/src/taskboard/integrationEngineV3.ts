import type {
  TaskBoardIntegrationCandidate,
  TaskBoardIntegrationCandidateRevision,
  TaskBoardIntegrationCandidateSourceSnapshot,
  TaskBoardRepositoryConfig,
} from '../../../shared/src/types/taskboard.js';
import type { AppendCandidateRevisionInput, TransitionCandidateInput } from './integrationCandidateStore.js';
import {
  IntegrationProviderOperationService,
  integrationProviderOperationKey,
  type IntegrationProviderOperationRecord,
  type IntegrationProviderReconcileResult,
} from './integrationProviderOperations.js';
import { TaskboardValidationError } from './types.js';

export interface IntegrationEngineV3ExpectedSubject {
  candidateVersion: number;
  candidateRevision: number;
  workflowEpoch: string;
  laneEpoch: string;
  repositoryId: string;
  baseOid?: string;
  headOid?: string;
  treeOid?: string;
  sourceSetDigest?: string;
  policyRevision: string;
  policySnapshotDigest?: string;
  subjectDigest?: string;
}

export interface IntegrationEngineV3Current {
  candidate: TaskBoardIntegrationCandidate;
  revision?: TaskBoardIntegrationCandidateRevision;
}

export interface IntegrationEngineV3CandidateHost {
  getCurrent(candidateId: string): Promise<IntegrationEngineV3Current>;
  appendRevision(candidateId: string, input: AppendCandidateRevisionInput): Promise<TaskBoardIntegrationCandidate>;
  beginNextWorkRound(candidateId: string, expectedVersion: number, expectedRevision: number): Promise<TaskBoardIntegrationCandidate>;
  transition(candidateId: string, input: TransitionCandidateInput): Promise<TaskBoardIntegrationCandidate>;
  /** Must atomically mark candidate merged and converge task/source/lane projections. */
  commitMerged(input: {
    candidateId: string;
    expectedVersion: number;
    expectedRevision: number;
    mergedCommitOid: string;
    providerOperationId: string;
  }): Promise<TaskBoardIntegrationCandidate>;
}

export interface IntegrationEngineV3ProviderFacts {
  repositoryId: string;
  providerPullRequestId: string;
  state: 'open' | 'closed' | 'merged';
  baseBranch: string;
  baseOid: string;
  headOid: string;
  treeOid: string;
  requiredChecksKnown: boolean;
  requiredChecks: Array<{ name: string; status: 'pending' | 'success' | 'failure'; appId?: number }>;
  unsupportedRules: string[];
  mergeQueueRequired: boolean;
  mergeCommitOid?: string;
  mergedTreeOid?: string;
}

export interface IntegrationEngineV3ProviderHost {
  readFacts(repository: TaskBoardRepositoryConfig, providerPullRequestId: string, credentialOwnerId: string): Promise<IntegrationEngineV3ProviderFacts>;
  merge(repository: TaskBoardRepositoryConfig, input: {
    providerPullRequestId: string;
    expectedHeadOid: string;
    method: 'merge' | 'squash' | 'rebase';
    operationKey: string;
  }, credentialOwnerId: string): Promise<Record<string, unknown>>;
  reconcileMerge(operation: IntegrationProviderOperationRecord, repository: TaskBoardRepositoryConfig, credentialOwnerId: string): Promise<IntegrationProviderReconcileResult>;
}

export interface IntegrationEngineV3Flags {
  enabled: boolean;
  composeEnabled: boolean;
  reviewEnabled: boolean;
  mergeEnabled: boolean;
  cleanupEnabled: boolean;
  workspaceSyncEnabled?: boolean;
}
export interface IntegrationEngineV3FeatureHost {
  /** Candidate policy flags are immutable for the lifetime of this candidate. Dynamic operational freezes belong outside the engine. */
  getFlags(candidateId: string): Promise<IntegrationEngineV3Flags>;
}

export interface IntegrationEngineV3RequestHost {
  /** Requests are durable, idempotent by their complete subject tuple, and dispatch-time fenced. */
  requestWork(input: { candidateId: string; revision: number; workRound: number; subjectDigest: string }): Promise<{ requestId: string; status?: string }>;
  requestReview(input: { candidateId: string; revision: number; subjectDigest: string; sourceSetDigest: string }): Promise<{ requestId: string; status?: string }>;
  requestWorkspaceSync(input: { candidateId: string; revision: number; baseBranch: string; expectedBaseOid: string }): Promise<{ requestId: string }>;
  requestCleanup(input: { candidateId: string; branch: string; providerPullRequestId?: string; reason: string }): Promise<{ requestId: string }>;
}

interface CommandBase { candidateId: string; expected: IntegrationEngineV3ExpectedSubject; }
export type IntegrationEngineV3Command =
  | (CommandBase & { type: 'start_compose' })
  | (CommandBase & { type: 'compose_clean'; revision: Omit<AppendCandidateRevisionInput, 'expectedVersion' | 'expectedCurrentRevision' | 'nextState'> })
  | (CommandBase & { type: 'compose_conflict'; evidence: string })
  | (CommandBase & { type: 'observe_checks' })
  | (CommandBase & { type: 'request_work' })
  | (CommandBase & { type: 'subject_refreshed'; revision: Omit<AppendCandidateRevisionInput, 'expectedVersion' | 'expectedCurrentRevision' | 'nextState'> })
  | (CommandBase & { type: 'request_review' })
  | (CommandBase & { type: 'review_approved'; reviewExecutionId: string; receipt: IntegrationReviewReceiptV3 })
  | (CommandBase & { type: 'review_changes_requested'; reviewExecutionId: string; receipt: IntegrationReviewReceiptV3 })
  | (CommandBase & { type: 'merge_approved'; executionId: string })
  | (CommandBase & { type: 'reconcile_merge'; operationKey: string })
  | (CommandBase & { type: 'needs_human'; reason: string })
  | (CommandBase & { type: 'cancel'; reason: string })
  | (CommandBase & { type: 'cleanup'; reason: string })
  | (CommandBase & { type: 'sync_main' });

export interface IntegrationReviewReceiptV3 {
  candidateId: string;
  revision: number;
  subjectDigest: string;
  sourceSetDigest: string;
}

export interface IntegrationEngineV3Result {
  candidate: TaskBoardIntegrationCandidate;
  status: 'applied' | 'waiting' | 'provider_unknown' | 'requested';
  requestId?: string;
  operation?: IntegrationProviderOperationRecord;
}

export interface IntegrationEngineV3Options {
  candidates: IntegrationEngineV3CandidateHost;
  providerOperations: IntegrationProviderOperationService;
  provider: IntegrationEngineV3ProviderHost;
  features: IntegrationEngineV3FeatureHost;
  requests: IntegrationEngineV3RequestHost;
  resolveRepository(repositoryId: string): Promise<TaskBoardRepositoryConfig | undefined>;
  credentialOwnerId: string;
}

/** Command-driven v3 engine. Candidate/revision rows are authoritative; task/source rows are never read for decisions. */
export class IntegrationEngineV3 {
  constructor(private readonly options: IntegrationEngineV3Options) {}

  async execute(command: IntegrationEngineV3Command): Promise<IntegrationEngineV3Result> {
    const current = await this.options.candidates.getCurrent(command.candidateId);
    assertExpected(current, command.expected);
    const flags = await this.options.features.getFlags(current.candidate.id);
    // A global freeze stops new work/provider writes, but must never prevent reconciliation or cancellation.
    if (!flags.enabled && !['reconcile_merge', 'cancel', 'needs_human'].includes(command.type)) {
      throw failClosed('Integration Engine v3 is disabled', 'TASKBOARD_INTEGRATION_V3_DISABLED');
    }

    switch (command.type) {
      case 'start_compose':
        assertFlag(flags.composeEnabled, 'compose');
        return applied(await this.transition(current, 'composing'));
      case 'compose_clean':
        assertFlag(flags.composeEnabled, 'compose');
        return applied(await this.appendAndTransition(current, command.revision, 'waiting_checks'));
      case 'compose_conflict':
        assertFlag(flags.composeEnabled, 'compose');
        return applied(await this.transition(current, 'needs_work', command.evidence));
      case 'observe_checks':
        return this.observeChecks(current, false);
      case 'request_work': {
        assertFlag(flags.composeEnabled, 'work');
        const revision = requireRevision(current);
        if (!['needs_work', 'working'].includes(current.candidate.state)) {
          throw failClosed('Candidate is not awaiting or performing work', 'TASKBOARD_CANDIDATE_WORK_STATE_INVALID');
        }
        // Re-enqueueing in working is the deterministic repair for the outbox/candidate
        // two-write boundary. The durable request key makes this a no-op unless a failed
        // row needs to be revived.
        const workRound = current.candidate.state === 'needs_work'
          ? current.candidate.workRound + 1
          : current.candidate.workRound;
        const request = await this.options.requests.requestWork({ candidateId: current.candidate.id, revision: current.candidate.currentRevision, workRound, subjectDigest: revision.subjectDigest });
        if (current.candidate.state === 'working' && request.status === 'failed') {
          throw failClosed('Work request exhausted retries and requires operator recovery', 'TASKBOARD_CANDIDATE_REQUEST_FAILED');
        }
        const candidate = current.candidate.state === 'needs_work'
          ? await this.options.candidates.beginNextWorkRound(current.candidate.id, current.candidate.version, current.candidate.currentRevision)
          : current.candidate;
        return { candidate, status: 'requested', requestId: request.requestId };
      }
      case 'subject_refreshed':
        assertFlag(flags.composeEnabled, 'compose');
        return applied(await this.appendAndTransition(current, command.revision, 'waiting_checks'));
      case 'request_review':
        assertFlag(flags.reviewEnabled, 'review');
        if (current.candidate.state === 'in_review') {
          // Deterministically repair a request lost/failed after the candidate transition.
          const revision = requireRevision(current);
          const request = await this.options.requests.requestReview({ candidateId: current.candidate.id, revision: revision.revision, subjectDigest: revision.subjectDigest, sourceSetDigest: revision.sourceSetDigest });
          if (request.status === 'failed') {
            throw failClosed('Review request exhausted retries and requires operator recovery', 'TASKBOARD_CANDIDATE_REQUEST_FAILED');
          }
          return { candidate: current.candidate, status: 'requested', requestId: request.requestId };
        }
        return this.observeChecks(current, true);
      case 'review_approved':
        assertFlag(flags.reviewEnabled, 'review');
        assertReviewReceipt(current, command.reviewExecutionId, command.receipt);
        return applied(await this.transition(current, 'approved', undefined, command.reviewExecutionId));
      case 'review_changes_requested':
        assertReviewReceipt(current, command.reviewExecutionId, command.receipt);
        return applied(await this.transition(current, 'needs_work', 'Review requested changes'));
      case 'merge_approved':
        assertFlag(flags.mergeEnabled, 'merge');
        return this.mergeApproved(current, command.executionId);
      case 'reconcile_merge':
        return this.reconcileMerge(current, command.operationKey);
      case 'needs_human':
        return applied(await this.transition(current, 'needs_human', command.reason));
      case 'cancel':
        if (!command.reason.trim()) throw failClosed('Cancellation reason is required', 'TASKBOARD_INTEGRATION_CANCEL_REASON_REQUIRED');
        return applied(await this.transition(current, 'canceled', command.reason));
      case 'cleanup': {
        assertFlag(flags.cleanupEnabled, 'cleanup');
        if (!['merged', 'canceled'].includes(current.candidate.state)) throw failClosed('Cleanup requires a terminal candidate', 'TASKBOARD_INTEGRATION_CLEANUP_NOT_TERMINAL');
        const request = await this.options.requests.requestCleanup({ candidateId: current.candidate.id, branch: current.candidate.branch, providerPullRequestId: current.candidate.providerPullRequestId, reason: command.reason });
        return { candidate: current.candidate, status: 'requested', requestId: request.requestId };
      }
      case 'sync_main': {
        assertFlag(flags.workspaceSyncEnabled === true, 'workspace sync');
        const revision = requireRevision(current);
        const request = await this.options.requests.requestWorkspaceSync({ candidateId: current.candidate.id, revision: revision.revision, baseBranch: current.candidate.baseBranch, expectedBaseOid: revision.baseOid });
        return { candidate: current.candidate, status: 'requested', requestId: request.requestId };
      }
    }
  }

  private async observeChecks(current: IntegrationEngineV3Current, dispatchReview: boolean): Promise<IntegrationEngineV3Result> {
    const revision = requireRevision(current);
    const facts = await this.readProviderFacts(current);
    if (facts.repositoryId !== current.candidate.repositoryId
      || facts.providerPullRequestId !== requiredPr(current.candidate)
      || facts.baseBranch !== current.candidate.baseBranch
      || facts.headOid !== revision.headOid
      || facts.treeOid !== revision.treeOid
      || facts.state !== 'open') {
      throw failClosed('Provider subject drifted from the candidate revision', 'TASKBOARD_INTEGRATION_SUBJECT_DRIFT');
    }
    if (facts.baseOid !== revision.baseOid) {
      return applied(await this.transition(current, 'needs_work', 'Provider base advanced; candidate refresh required'));
    }
    if (!facts.requiredChecksKnown || facts.unsupportedRules.length || facts.mergeQueueRequired) {
      const reason = `Required GitHub gates are not authoritative or supported: ${facts.unsupportedRules.join(',') || 'unknown'}`;
      return applied(await this.transition(current, 'blocked', reason));
    }
    if (facts.requiredChecks.some((check) => check.status === 'failure')) return applied(await this.transition(current, 'needs_work', 'Required checks failed'));
    if (facts.requiredChecks.length === 0 || facts.requiredChecks.some((check) => check.status === 'pending')) {
      return { candidate: current.candidate, status: 'waiting' };
    }
    if (!dispatchReview) return { candidate: current.candidate, status: 'waiting' };
    const request = await this.options.requests.requestReview({ candidateId: current.candidate.id, revision: revision.revision, subjectDigest: revision.subjectDigest, sourceSetDigest: revision.sourceSetDigest });
    const candidate = await this.transition(current, 'in_review');
    return { candidate, status: 'requested', requestId: request.requestId };
  }

  private async mergeApproved(current: IntegrationEngineV3Current, executionId: string): Promise<IntegrationEngineV3Result> {
    const revision = requireRevision(current);
    const operationKey = integrationProviderOperationKey({ repositoryId: current.candidate.repositoryId, candidateId: current.candidate.id, candidateRevision: revision.revision, kind: 'merge_pull_request', target: requiredPr(current.candidate) });
    const facts = await this.readProviderFacts(current);
    if (facts.state === 'merged') {
      const exact = isExactMergedSubject(current, facts);
      return applied(await this.transition(
        current,
        'needs_human',
        exact
          ? 'Provider PR was merged outside the controlled Workflow v3 operation; audit or replacement validation is required'
          : 'Provider PR was externally merged with unknown or mismatched approved facts',
      ));
    }
    if (isBaseOnlyDrift(current, facts)) {
      const prepared = current.candidate.state === 'merging'
        ? await this.options.providerOperations.get(operationKey)
        : undefined;
      if (current.candidate.state === 'approved' || prepared?.state === 'prepared') {
        return applied(await this.transition(current, 'composing'));
      }
    }
    this.assertProviderFacts(current, facts);
    if (current.candidate.approvedRevision !== revision.revision || !current.candidate.approvedReviewExecutionId) throw failClosed('Approval is stale', 'TASKBOARD_CANDIDATE_APPROVAL_STALE');
    const operation = await this.options.providerOperations.prepare({
      operationKey, kind: 'merge_pull_request', repositoryId: current.candidate.repositoryId,
      fence: { workflowEpoch: safeEpoch(current.candidate.workflowEpoch), laneEpoch: safeEpoch(current.candidate.laneEpoch), candidateId: current.candidate.id, candidateRevision: revision.revision, executionId },
      expected: subjectExpected(current, revision),
      command: { providerPullRequestId: requiredPr(current.candidate), expectedHeadOid: revision.headOid, method: current.candidate.mergeMethod },
    });
    const merging = current.candidate.state === 'merging' ? current.candidate : await this.transition(current, 'merging');
    const repository = await this.repository(current.candidate.repositoryId);
    const completed = await this.options.providerOperations.execute(operationKey, async () => {
      const receipt = await this.options.provider.merge(repository, { providerPullRequestId: requiredPr(current.candidate), expectedHeadOid: revision.headOid, method: current.candidate.mergeMethod, operationKey }, this.options.credentialOwnerId);
      return { ...receipt, providerPullRequestId: requiredPr(current.candidate) };
    });
    if (completed.state !== 'succeeded') return { candidate: merging, status: 'provider_unknown', operation: completed };
    return this.finishMerge({ candidate: merging, revision }, completed);
  }

  private async reconcileMerge(current: IntegrationEngineV3Current, operationKey: string): Promise<IntegrationEngineV3Result> {
    if (current.candidate.state !== 'merging') throw failClosed('Only a merging candidate can reconcile', 'TASKBOARD_INTEGRATION_RECONCILE_STATE_INVALID');
    const repository = await this.repository(current.candidate.repositoryId);
    const operation = await this.options.providerOperations.reconcile(operationKey, (record) => this.options.provider.reconcileMerge(record, repository, this.options.credentialOwnerId));
    if (operation.state !== 'succeeded') return { candidate: current.candidate, status: 'provider_unknown', operation };
    return this.finishMerge(current as Required<IntegrationEngineV3Current>, operation);
  }

  private async finishMerge(current: Required<IntegrationEngineV3Current>, operation: IntegrationProviderOperationRecord): Promise<IntegrationEngineV3Result> {
    const facts = await this.readAndValidateFacts(current, true);
    if (facts.state !== 'merged' || !facts.mergeCommitOid || !facts.mergedTreeOid || facts.mergedTreeOid !== current.revision.treeOid) {
      const candidate = await this.transition(current, 'needs_human', 'Merged provider facts or merged tree are unknown/mismatched');
      return { candidate, status: 'provider_unknown', operation };
    }
    const candidate = await this.options.candidates.commitMerged({ candidateId: current.candidate.id, expectedVersion: current.candidate.version, expectedRevision: current.revision.revision, mergedCommitOid: facts.mergeCommitOid, providerOperationId: operation.id });
    return { candidate, status: 'applied', operation };
  }

  private async readProviderFacts(current: IntegrationEngineV3Current): Promise<IntegrationEngineV3ProviderFacts> {
    const repository = await this.repository(current.candidate.repositoryId);
    try {
      return await this.options.provider.readFacts(
        repository,
        requiredPr(current.candidate),
        this.options.credentialOwnerId,
      );
    } catch (error) {
      throw failClosed(`Provider facts are unknown: ${errorMessage(error)}`, 'TASKBOARD_INTEGRATION_PROVIDER_FACTS_UNKNOWN');
    }
  }

  private async readAndValidateFacts(current: IntegrationEngineV3Current, allowMerged = false): Promise<IntegrationEngineV3ProviderFacts> {
    const facts = await this.readProviderFacts(current);
    this.assertProviderFacts(current, facts, allowMerged);
    return facts;
  }

  private assertProviderFacts(
    current: IntegrationEngineV3Current,
    facts: IntegrationEngineV3ProviderFacts,
    allowMerged = false,
  ): void {
    const revision = requireRevision(current);
    const merged = allowMerged && facts.state === 'merged';
    if (facts.repositoryId !== current.candidate.repositoryId
      || facts.providerPullRequestId !== requiredPr(current.candidate)
      || facts.baseBranch !== current.candidate.baseBranch
      || facts.headOid !== revision.headOid
      || facts.treeOid !== revision.treeOid
      || (!merged && (facts.state !== 'open' || facts.baseOid !== revision.baseOid))) {
      throw failClosed('Provider subject drifted from the candidate revision', 'TASKBOARD_INTEGRATION_SUBJECT_DRIFT');
    }
  }

  private async appendAndTransition(current: IntegrationEngineV3Current, revision: Omit<AppendCandidateRevisionInput, 'expectedVersion' | 'expectedCurrentRevision' | 'nextState'>, to: 'waiting_checks'): Promise<TaskBoardIntegrationCandidate> {
    return this.options.candidates.appendRevision(current.candidate.id, {
      ...revision,
      expectedVersion: current.candidate.version,
      expectedCurrentRevision: current.candidate.currentRevision,
      nextState: to,
    });
  }

  private transition(current: IntegrationEngineV3Current, to: TransitionCandidateInput['to'], lastError?: string, approvedReviewExecutionId?: string): Promise<TaskBoardIntegrationCandidate> {
    return this.options.candidates.transition(current.candidate.id, { expectedVersion: current.candidate.version, expectedRevision: current.candidate.currentRevision, to, lastError, approvedReviewExecutionId });
  }

  private async repository(repositoryId: string): Promise<TaskBoardRepositoryConfig> {
    const repository = await this.options.resolveRepository(repositoryId);
    if (!repository || repository.provider !== 'github') throw failClosed('Repository provider is unsupported or unknown', 'TASKBOARD_INTEGRATION_PROVIDER_UNSUPPORTED');
    return repository;
  }
}

function assertExpected(current: IntegrationEngineV3Current, expected: IntegrationEngineV3ExpectedSubject): void {
  const c = current.candidate;
  if (c.version !== expected.candidateVersion || c.currentRevision !== expected.candidateRevision || c.workflowEpoch !== expected.workflowEpoch
    || c.laneEpoch !== expected.laneEpoch || c.repositoryId !== expected.repositoryId || c.policyRevision !== expected.policyRevision) throw casMismatch();
  if (c.currentRevision === 0) {
    if (current.revision || expected.baseOid || expected.headOid || expected.treeOid || expected.sourceSetDigest || expected.subjectDigest || expected.policySnapshotDigest) throw casMismatch();
    return;
  }
  const r = requireRevision(current);
  if (r.revision !== c.currentRevision || r.baseOid !== expected.baseOid || r.headOid !== expected.headOid || r.treeOid !== expected.treeOid
    || r.sourceSetDigest !== expected.sourceSetDigest || r.policyRevision !== expected.policyRevision
    || r.policySnapshotDigest !== expected.policySnapshotDigest || r.subjectDigest !== expected.subjectDigest) throw casMismatch();
}
function assertReviewReceipt(current: IntegrationEngineV3Current, executionId: string, receipt: IntegrationReviewReceiptV3): void {
  const r = requireRevision(current);
  if (!executionId || receipt.candidateId !== current.candidate.id || receipt.revision !== r.revision || receipt.subjectDigest !== r.subjectDigest || receipt.sourceSetDigest !== r.sourceSetDigest) throw failClosed('Review receipt does not bind the current subject', 'TASKBOARD_INTEGRATION_REVIEW_RECEIPT_STALE');
}
function isExactMergedSubject(current: IntegrationEngineV3Current, facts: IntegrationEngineV3ProviderFacts): boolean {
  const revision = requireRevision(current);
  return facts.repositoryId === current.candidate.repositoryId
    && facts.providerPullRequestId === requiredPr(current.candidate)
    && facts.baseBranch === current.candidate.baseBranch
    && facts.headOid === revision.headOid
    && facts.treeOid === revision.treeOid
    && Boolean(facts.mergeCommitOid)
    && facts.mergedTreeOid === revision.treeOid;
}
function isBaseOnlyDrift(current: IntegrationEngineV3Current, facts: IntegrationEngineV3ProviderFacts): boolean {
  const revision = requireRevision(current);
  return facts.repositoryId === current.candidate.repositoryId
    && facts.providerPullRequestId === requiredPr(current.candidate)
    && facts.baseBranch === current.candidate.baseBranch
    && facts.headOid === revision.headOid
    && facts.treeOid === revision.treeOid
    && facts.state === 'open'
    && facts.baseOid !== revision.baseOid;
}
function subjectExpected(current: IntegrationEngineV3Current, revision: TaskBoardIntegrationCandidateRevision): Record<string, unknown> { return { repositoryId: current.candidate.repositoryId, baseOid: revision.baseOid, headOid: revision.headOid, treeOid: revision.treeOid, sourceSetDigest: revision.sourceSetDigest, policyRevision: revision.policyRevision, policySnapshotDigest: revision.policySnapshotDigest, subjectDigest: revision.subjectDigest }; }
function requireRevision(current: IntegrationEngineV3Current): TaskBoardIntegrationCandidateRevision { if (!current.revision || current.revision.revision !== current.candidate.currentRevision) throw failClosed('Current candidate revision is unavailable', 'TASKBOARD_INTEGRATION_REVISION_UNKNOWN'); return current.revision; }
function requiredPr(candidate: TaskBoardIntegrationCandidate): string { if (!candidate.providerPullRequestId) throw failClosed('Integration PR identity is unknown', 'TASKBOARD_INTEGRATION_PR_UNKNOWN'); return candidate.providerPullRequestId; }
function safeEpoch(value: string): number { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw failClosed('Workflow or lane epoch is outside safe integer range', 'TASKBOARD_INTEGRATION_EPOCH_INVALID'); return number; }
function assertFlag(enabled: boolean, action: string): void { if (!enabled) throw failClosed(`Integration ${action} kill switch is active`, 'TASKBOARD_INTEGRATION_KILL_SWITCH'); }
function failClosed(message: string, code: string): TaskboardValidationError { return new TaskboardValidationError(message, code); }
function casMismatch(): TaskboardValidationError { return failClosed('Candidate subject or fence changed; reload before retrying', 'TASKBOARD_CANDIDATE_CAS_MISMATCH'); }
function applied(candidate: TaskBoardIntegrationCandidate): IntegrationEngineV3Result { return { candidate, status: 'applied' }; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export type IntegrationEngineV3SourceInput = Omit<TaskBoardIntegrationCandidateSourceSnapshot, 'candidateId' | 'revision' | 'createdAt'>;
