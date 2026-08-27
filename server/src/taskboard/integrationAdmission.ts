import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

import type {
  TaskBoardIntegrationPolicy,
  TaskBoardRepositoryConfig,
} from '../../../shared/src/types/taskboard.js';

export interface IntegrationAdmissionSource {
  id: string;
  deliveryTaskId: string;
  providerPullRequestId: string;
  reviewedSubjectDigest: string;
  frozenHeadOid: string;
  sourceOrder: number;
}

export interface IntegrationAdmissionBinding {
  candidateId: string;
  candidateRevision: number;
  reviewExecutionId: string;
  headOid: string;
  baseOid: string;
  treeOid: string;
  subjectDigest: string;
  workflowEpoch: number;
  laneEpoch: number;
  policyRevision: string;
  policyDigest: string;
  sourceSetDigest: string;
}

export interface IntegrationAdmissionReceipt extends IntegrationAdmissionBinding {
  schemaVersion: 1;
  createdAt: string;
  receiptDigest: string;
}

export interface IntegrationAdmissionContext {
  candidateRevision: number;
  workflowEpoch: number;
  laneEpoch: number;
  policyRevision: string;
  policyDigest: string;
  sourceSetDigest: string;
  sources: IntegrationAdmissionSource[];
  repository: TaskBoardRepositoryConfig;
  policy: TaskBoardIntegrationPolicy;
  credentialOwnerId: string;
}

interface AdmissionTables {
  tasksTable: string;
  boardsTable: string;
  integrationLanesTable: string;
  integrationSourcesTable: string;
}

export async function loadIntegrationAdmissionContext(
  tables: AdmissionTables,
  client: Pick<PoolClient, 'query'>,
  candidateId: string,
): Promise<IntegrationAdmissionContext> {
  const result = await client.query(
    `SELECT t.version,t.workflow_epoch,b.repository,b.integration_policy,b.owner_user_id,
            lane.epoch AS lane_epoch,lane.active_integration_task_id
       FROM ${tables.tasksTable} t
       JOIN ${tables.boardsTable} b ON b.id=t.board_id
       JOIN ${tables.integrationLanesTable} lane
         ON lane.board_id=b.id AND lane.repository_id=b.repository->>'repositoryId'
      WHERE t.id=$1 AND t.kind='integration'
      FOR SHARE OF t,b,lane`,
    [candidateId],
  );
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row || String(row.active_integration_task_id ?? '') !== candidateId) {
    throw new Error('Integration candidate is not the active lane subject');
  }
  const repository = objectValue(row.repository) as TaskBoardRepositoryConfig | undefined;
  const policy = objectValue(row.integration_policy) as TaskBoardIntegrationPolicy | undefined;
  const policyRevision = typeof policy?.revision === 'string' ? policy.revision.trim() : '';
  if (!repository || repository.provider !== 'github' || !policy || !policyRevision) {
    throw new Error('Integration candidate repository or policy revision is unavailable');
  }
  const sourceResult = await client.query(
    `SELECT id,delivery_task_id,provider_pull_request_id,reviewed_subject_digest,
            frozen_head_oid,source_order
       FROM ${tables.integrationSourcesTable}
      WHERE integration_task_id=$1
      ORDER BY source_order,id
      FOR SHARE`,
    [candidateId],
  );
  const sources = sourceResult.rows.map((source): IntegrationAdmissionSource => ({
    id: String(source.id),
    deliveryTaskId: String(source.delivery_task_id),
    providerPullRequestId: String(source.provider_pull_request_id),
    reviewedSubjectDigest: String(source.reviewed_subject_digest),
    frozenHeadOid: String(source.frozen_head_oid ?? ''),
    sourceOrder: Number(source.source_order),
  }));
  if (
    sources.length === 0 ||
    sources.some(
      (source) =>
        !source.id ||
        !source.deliveryTaskId ||
        !source.providerPullRequestId ||
        !source.reviewedSubjectDigest ||
        !source.frozenHeadOid ||
        !Number.isInteger(source.sourceOrder) ||
        source.sourceOrder < 0,
    )
  ) {
    throw new Error('Integration candidate source set is incomplete');
  }
  const candidateRevision = Number(row.version);
  const workflowEpoch = Number(row.workflow_epoch);
  const laneEpoch = Number(row.lane_epoch);
  if (![candidateRevision, workflowEpoch, laneEpoch].every(Number.isSafeInteger)) {
    throw new Error('Integration candidate revision epochs are invalid');
  }
  return {
    candidateRevision,
    workflowEpoch,
    laneEpoch,
    policyRevision,
    policyDigest: digestCanonical(policy),
    sourceSetDigest: digestCanonical(sources),
    sources,
    repository,
    policy,
    credentialOwnerId: String(row.owner_user_id),
  };
}

export function createIntegrationAdmissionReceipt(
  binding: IntegrationAdmissionBinding,
  createdAt = new Date().toISOString(),
): IntegrationAdmissionReceipt {
  const payload = { schemaVersion: 1 as const, ...binding, createdAt };
  return { ...payload, receiptDigest: digestCanonical(payload) };
}

export function verifyIntegrationAdmissionReceipt(
  value: unknown,
  expected: IntegrationAdmissionBinding,
): { ok: true; receipt: IntegrationAdmissionReceipt } | { ok: false; reason: string } {
  const receipt = objectValue(value) as unknown as IntegrationAdmissionReceipt | undefined;
  if (
    !receipt ||
    receipt.schemaVersion !== 1 ||
    typeof receipt.createdAt !== 'string' ||
    typeof receipt.receiptDigest !== 'string'
  ) {
    return { ok: false, reason: 'approval receipt is missing or malformed' };
  }
  const { receiptDigest, ...payload } = receipt;
  if (digestCanonical(payload) !== receiptDigest) {
    return { ok: false, reason: 'approval receipt digest is invalid' };
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (receipt[key as keyof IntegrationAdmissionBinding] !== expectedValue) {
      return { ok: false, reason: `${key} drifted after approval` };
    }
  }
  return { ok: true, receipt };
}

export function digestCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot canonicalize non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`Cannot canonicalize ${typeof value}`);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
