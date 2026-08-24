import { createHash } from 'node:crypto';

import type {
  TaskBoardIntegrationCandidateDigestVersion,
  TaskBoardIntegrationCandidateSourceSnapshot,
  TaskBoardIntegrationMergeMethod,
} from '../../../shared/src/types/taskboard.js';

export const INTEGRATION_CANDIDATE_DIGEST_VERSION = 1 as const;

type SourceDigestInput = Omit<TaskBoardIntegrationCandidateSourceSnapshot, 'candidateId' | 'revision' | 'createdAt'>;

export interface IntegrationCandidateSubjectDigestInput {
  repository: {
    repositoryId: string;
    baseBranch: string;
  };
  baseOid: string;
  headOid: string;
  treeOid: string;
  sourceSetDigest: string;
  mergeMethod: TaskBoardIntegrationMergeMethod;
  policyRevision: string;
  policySnapshot: Record<string, unknown>;
  digestVersion?: TaskBoardIntegrationCandidateDigestVersion;
}

export function computeIntegrationSourceSetDigest(
  sources: readonly SourceDigestInput[],
  digestVersion: TaskBoardIntegrationCandidateDigestVersion = INTEGRATION_CANDIDATE_DIGEST_VERSION,
): string {
  assertContiguousSourceOrder(sources);
  return versionedDigest('taskboard.integration-source-set', digestVersion, sources.map((source) => ({
    order: source.order,
    integrationSourceId: required(source.integrationSourceId, 'integrationSourceId'),
    deliveryTaskId: required(source.deliveryTaskId, 'deliveryTaskId'),
    deliveryTaskVersion: positiveInteger(source.deliveryTaskVersion, 'deliveryTaskVersion'),
    repositoryId: required(source.repositoryId, 'repositoryId'),
    providerPullRequestId: required(source.providerPullRequestId, 'providerPullRequestId'),
    frozenHeadOid: required(source.frozenHeadOid, 'frozenHeadOid'),
    frozenBaseOid: required(source.frozenBaseOid, 'frozenBaseOid'),
    reviewedSubjectDigest: required(source.reviewedSubjectDigest, 'reviewedSubjectDigest'),
    reviewExecutionId: required(source.reviewExecutionId, 'reviewExecutionId'),
    reviewReceiptDigest: required(source.reviewReceiptDigest, 'reviewReceiptDigest'),
    requirementDigest: required(source.requirementDigest, 'requirementDigest'),
  })));
}

export function computeIntegrationReviewReceiptDigest(
  executionId: string,
  reviewedSubjectDigest: string,
): string {
  return versionedDigest('taskboard.integration-review-receipt', INTEGRATION_CANDIDATE_DIGEST_VERSION, {
    executionId: required(executionId, 'executionId'),
    reviewedSubjectDigest: required(reviewedSubjectDigest, 'reviewedSubjectDigest'),
  });
}

export function computeIntegrationRequirementDigest(title: string, description: string): string {
  return versionedDigest('taskboard.integration-requirement', INTEGRATION_CANDIDATE_DIGEST_VERSION, {
    title,
    description,
  });
}

export function computeIntegrationSourceSeedDigest(input: {
  repositoryId: string;
  baseBranch: string;
  baseOid: string;
  headOid: string;
  sourceSetDigest: string;
  mergeMethod: TaskBoardIntegrationMergeMethod;
  policyRevision: string;
  policySnapshotDigest: string;
  recomposeRevision?: number;
}): string {
  return versionedDigest('taskboard.integration-candidate-source-seed', INTEGRATION_CANDIDATE_DIGEST_VERSION, {
    repositoryId: required(input.repositoryId, 'repositoryId'),
    baseBranch: required(input.baseBranch, 'baseBranch'),
    baseOid: required(input.baseOid, 'baseOid'),
    headOid: required(input.headOid, 'headOid'),
    sourceSetDigest: required(input.sourceSetDigest, 'sourceSetDigest'),
    mergeMethod: input.mergeMethod,
    policyRevision: required(input.policyRevision, 'policyRevision'),
    policySnapshotDigest: required(input.policySnapshotDigest, 'policySnapshotDigest'),
    ...(input.recomposeRevision === undefined ? {} : { recomposeRevision: positiveInteger(input.recomposeRevision, 'recomposeRevision') }),
  });
}

export function computeIntegrationPolicySnapshotDigest(
  policySnapshot: Record<string, unknown>,
  digestVersion: TaskBoardIntegrationCandidateDigestVersion = INTEGRATION_CANDIDATE_DIGEST_VERSION,
): string {
  return versionedDigest('taskboard.integration-policy-snapshot', digestVersion, policySnapshot);
}

export function computeIntegrationCandidateSubjectDigest(
  input: IntegrationCandidateSubjectDigestInput,
): string {
  const digestVersion = input.digestVersion ?? INTEGRATION_CANDIDATE_DIGEST_VERSION;
  const policySnapshotDigest = computeIntegrationPolicySnapshotDigest(input.policySnapshot, digestVersion);
  return versionedDigest('taskboard.integration-candidate-subject', digestVersion, {
    repository: {
      repositoryId: required(input.repository.repositoryId, 'repository.repositoryId'),
      baseBranch: required(input.repository.baseBranch, 'repository.baseBranch'),
    },
    baseOid: required(input.baseOid, 'baseOid'),
    headOid: required(input.headOid, 'headOid'),
    treeOid: required(input.treeOid, 'treeOid'),
    sourceSetDigest: required(input.sourceSetDigest, 'sourceSetDigest'),
    mergeMethod: input.mergeMethod,
    policyRevision: required(input.policyRevision, 'policyRevision'),
    policySnapshotDigest,
    policySnapshot: input.policySnapshot,
  });
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Digest input contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => {
        if (entry === undefined) throw new TypeError(`Digest input contains undefined at ${key}`);
        return `${JSON.stringify(key)}:${canonicalJson(entry)}`;
      });
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`Unsupported digest input type: ${typeof value}`);
}

function versionedDigest(domain: string, version: number, payload: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson({ domain, version, payload })).digest('hex')}`;
}

function assertContiguousSourceOrder(sources: readonly SourceDigestInput[]): void {
  const identities = new Set<string>();
  sources.forEach((source, index) => {
    if (source.order !== index) {
      throw new TypeError(`Candidate source order must be contiguous from zero; expected ${index}, got ${source.order}`);
    }
    if (identities.has(source.integrationSourceId)) {
      throw new TypeError(`Duplicate integration source: ${source.integrationSourceId}`);
    }
    identities.add(source.integrationSourceId);
  });
  if (sources.length === 0) throw new TypeError('Candidate source set must not be empty');
}

function required(value: string, field: string): string {
  if (!value.trim()) throw new TypeError(`${field} is required`);
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`);
  return value;
}
