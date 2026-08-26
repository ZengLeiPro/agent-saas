import { z } from 'zod';
import type {
  AccessDecision,
  EffectiveResourceView,
  ExecutionReadiness,
  ManagementSnapshotRequestV1,
  ManagementSnapshotResponseV1,
} from '../types/governance';
import type { GovernanceSkillImportResponse } from '../types/skill';
import {
  accessDecisionSchema,
  assertGovernanceUiSafe,
  effectiveResourceViewSchema,
  executionReadinessSchema,
  managementSnapshotRequestV1Schema,
  managementSnapshotResponseV1Schema,
  parseGovernanceDto,
} from '../types/governance';
import { authFetch } from './authFetch';
import { parseJsonResponse } from './parseJsonResponse';
import {
  agentListSchema, assignmentBatchPreviewSchema, assignmentBatchReceiptSchema,
  auditListSchema, changeJobSchema, credentialListSchema, credentialOperationPreviewSchema, directoryGroupListSchema,
  entitlementCatalogSchema, entitlementPreviewSchema, entitlementResponseSchema,
  environmentTemplateListSchema, governanceReceiptSchema, lifecycleMutationReceiptSchema,
  lifecyclePreviewSchema, lifecycleResponseSchema, memberDetailsSchema, membershipListSchema,
  membershipPreviewSchema, memoryKnowledgeListSchema, memoryResourcePreviewSchema, offboardingPreviewSchema,
  platformAdminListSchema, policyPreviewSchema, scopePreviewSchema,
} from './governanceUiSchemas';

const ACCESS_BASE = '/api/governance/access';
const RESOURCE_BASE = '/api/governance/resources';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const LIFECYCLE_MUTATION_SUCCESS_CODES = new Set(['TENANT_LIFECYCLE_PROPAGATION_PENDING']);

type QueryValue = string | number | boolean | null | undefined;
export type GovernanceCommand = Record<string, unknown>;

export class GovernanceApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'GovernanceApiError';
  }
}

function withQuery(path: string, query?: Record<string, QueryValue>): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function body(method: string, value?: unknown): RequestInit {
  return {
    method,
    ...(value === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(value) }),
  };
}

function isSuccessCode(code: unknown): boolean {
  return code === 0 || code === 200 || code === '0' || code === '200'
    || code === 'OK' || code === 'SUCCESS';
}

function backendError(
  value: unknown,
  acceptedSuccessCodes?: ReadonlySet<string>,
): { code: string; message: string } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.code === undefined) return undefined;
  const code = String(record.code);
  if (isSuccessCode(record.code) || acceptedSuccessCodes?.has(code)) return undefined;
  const message = typeof record.message === 'string'
    ? record.message
    : typeof record.error === 'string' ? record.error : code;
  return { code, message };
}

function unwrapEnvelope(value: unknown, acceptedSuccessCodes?: ReadonlySet<string>): unknown {
  const error = backendError(value, acceptedSuccessCodes);
  if (error) throw new GovernanceApiError(error.code, error.message);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const successCode = isSuccessCode(record.code);
    if (successCode && Object.prototype.hasOwnProperty.call(record, 'data')) return record.data;
  }
  return value;
}

async function request<T = unknown>(
  path: string,
  init?: RequestInit,
  schema?: z.ZodType<T>,
  acceptedSuccessCodes?: ReadonlySet<string>,
): Promise<T> {
  const response = await authFetch(path, init);
  const errorCopy = !response.ok ? response.clone() : undefined;
  let raw: unknown;
  try {
    raw = await parseJsonResponse(response, '治理');
  } catch (cause) {
    if (errorCopy) {
      const errorBody = await errorCopy.json().catch(() => undefined) as unknown;
      const coded = backendError(errorBody);
      if (coded) throw new GovernanceApiError(coded.code, coded.message, response.status);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new GovernanceApiError(`HTTP_${response.status}`, message, response.status);
  }

  const payload = unwrapEnvelope(raw, response.ok ? acceptedSuccessCodes : undefined);
  try {
    if (schema) return parseGovernanceDto(schema, payload);
    assertGovernanceUiSafe(payload);
    return payload as T;
  } catch (cause) {
    if (cause instanceof GovernanceApiError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new GovernanceApiError('INVALID_GOVERNANCE_RESPONSE', message, response.status);
  }
}

const schemaFor = <T>(schema: z.ZodTypeAny): z.ZodType<T> => schema as unknown as z.ZodType<T>;
const id = encodeURIComponent;
const tenant = (tenantId?: string) => ({ tenantId });

export const oauthApprovalRecordSchema = z.object({
  approvalId: z.string().min(1), grantId: z.string().min(1),
  action: z.enum(['approved', 'revoked', 'expired', 'refreshed']),
  scopeSummary: z.array(z.string()), purpose: z.string(), actorUserId: z.string().min(1),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();
export const oauthGrantSchema = z.object({
  grantId: z.string().min(1), tenantId: z.string().min(1), subjectUserId: z.string().min(1),
  provider: z.string().min(1), connectorId: z.string().optional(),
  status: z.enum(['active', 'expired', 'revoked', 'error']), scopeSummary: z.array(z.string()),
  approvedAt: z.string().datetime({ offset: true }), expiresAt: z.string().datetime({ offset: true }).optional(),
  lastUsedAt: z.string().datetime({ offset: true }).optional(), version: z.number().int().positive(),
  revocationStage: z.enum(['local_blocked', 'provider_revoking', 'provider_revoked', 'local_finalized']).optional(),
  revocationAttempt: z.number().int().nonnegative().optional(),
  revocationNextRetryAt: z.string().datetime({ offset: true }).optional(), revocationLastErrorCode: z.string().optional(),
  approvals: z.array(oauthApprovalRecordSchema),
}).strict();
export const oauthGrantResponseSchema = z.object({ grants: z.array(oauthGrantSchema) }).strict();
const oauthMutationReceiptShape = {
  changeId: z.string().min(1),
  auditId: z.string().min(1),
  // 终态审计成功时不返回该字段；写入 durable outbox 时明确标记 pending。
  auditCompletion: z.literal('pending').optional(),
  auditProjectionId: z.string().min(1).optional(),
};
export const oauthRevocationPreviewSchema = z.object({
  previewId: z.string().regex(/^ogpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
  impact: z.object({
    provider: z.string(), connectorId: z.string().nullable(), action: z.literal('revoke'), immediatelyUnavailable: z.literal(true),
    newRuns: z.literal('blocked'), reversible: z.boolean(), effectiveMode: z.string(),
    affectedAgents: z.array(z.string()), affectedAutomations: z.array(z.string()), brokenReferences: z.array(z.string()),
    blockers: z.array(z.string()), warnings: z.array(z.string()),
    currentVersion: z.number().int().positive(), nextVersion: z.number().int().positive(),
  }).strict(),
  ...oauthMutationReceiptShape,
}).strict();
export const oauthRevocationResultSchema = z.object({
  grantId: z.string().min(1), status: z.enum(['revoked', 'error']), version: z.number().int().positive(),
  revocationStage: z.enum(['local_blocked', 'provider_revoking', 'provider_revoked', 'local_finalized']).optional(),
  retryAt: z.string().datetime({ offset: true }).optional(), projectionStatus: z.string().optional(),
  ...oauthMutationReceiptShape,
}).strict();
export type OAuthGrantResponse = z.infer<typeof oauthGrantResponseSchema>;
export type OAuthRevocationPreview = z.infer<typeof oauthRevocationPreviewSchema>;
export type OAuthRevocationResult = z.infer<typeof oauthRevocationResultSchema>;

const contextScopeSchema = z.object({
  enabled: z.boolean(),
  summary: z.string(),
  from: z.string().datetime({ offset: true }).nullable().optional(),
  through: z.string().datetime({ offset: true }).nullable().optional(),
  includes: z.array(z.string()).optional(),
}).strict().refine(
  value => !value.from || !value.through || Date.parse(value.from) <= Date.parse(value.through),
  { message: 'from must not be after through', path: ['through'] },
);
const contextBackfillCoverageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('items'),
    coveredItems: z.number().int().nonnegative(),
    totalItems: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('time'),
    coveredFrom: z.string().datetime({ offset: true }).nullable(),
    coveredThrough: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
]).superRefine((value, context) => {
  if (value.kind === 'items' && value.coveredItems > value.totalItems) {
    context.addIssue({
      code: 'custom', message: 'coveredItems must not exceed totalItems', path: ['coveredItems'],
    });
  }
  if (value.kind === 'time' && value.coveredFrom && value.coveredThrough
    && Date.parse(value.coveredFrom) > Date.parse(value.coveredThrough)) {
    context.addIssue({
      code: 'custom', message: 'coveredFrom must not be after coveredThrough', path: ['coveredThrough'],
    });
  }
});
export const contextSourceSchema = z.object({
  sourceId: z.string().min(1),
  name: z.string().min(1),
  system: z.string().min(1),
  collectionId: z.string().min(1),
  collection: z.string().min(1),
  status: z.enum(['healthy', 'syncing', 'attention', 'paused']),
  lastSyncedAt: z.string().datetime({ offset: true }).nullable(),
  backfillCoverage: contextBackfillCoverageSchema,
  watermarkLagSeconds: z.number().nonnegative().nullable(),
  ingestOutcomes: z.object({
    truncated: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    unreadable: z.number().int().nonnegative(),
    retrying: z.number().int().nonnegative(),
    lastErrorCodes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,119}$/)).max(16),
    nextRetryAt: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
  historicalLearningScope: contextScopeSchema,
  realtimeListeningScope: contextScopeSchema,
}).strict();
export const contextConsumerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  status: z.enum(['current', 'lagging', 'blocked', 'offline']),
  watermarkAt: z.string().datetime({ offset: true }).nullable(),
  lagSeconds: z.number().nonnegative().nullable(),
  detail: z.string().optional(),
}).strict();
export const contextCenterSnapshotSchema = z.object({
  generatedAt: z.string().datetime({ offset: true }),
  sources: z.array(contextSourceSchema),
  consumers: z.array(contextConsumerSchema),
}).strict();
export const contextEvidenceSchema = z.object({
  id: z.string().min(1),
  sourceName: z.string().min(1),
  collection: z.string().min(1),
  author: z.string().nullable(),
  occurredAt: z.string().datetime({ offset: true }),
  quote: z.string().min(1),
  derived: z.boolean(),
  freshness: z.enum(['fresh', 'aging', 'stale', 'unknown']),
  freshnessAsOf: z.string().datetime({ offset: true }).nullable(),
  originalUrl: z.string().nullable(),
}).strict();
const contextEvidenceListSchema = z.array(contextEvidenceSchema);

export type ContextCenterSnapshotDto = z.infer<typeof contextCenterSnapshotSchema>;
export type ContextEvidenceDto = z.infer<typeof contextEvidenceSchema>;

const contextAuthoritySchema = z.object({
  scope: z.enum(['personal', 'organization']),
  label: z.string().min(1),
}).strict();
export const contextEvidenceRefSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1).nullable(),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();
const contextReviewStateSchema = z.enum(['proposed', 'conflicted', 'confirmed', 'rejected']);
export const contextDerivedItemTypeSchema = z.enum(['Decision', 'Status', 'Task', 'Risk', 'Commitment']);
export const contextProfileFacetTypeSchema = z.enum(['role', 'tasks', 'workflow', 'artifacts', 'knowhow']);
const contextCommonShape = {
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1).nullable(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
  degraded: z.boolean(),
};
export const contextTimelineItemSchema = z.object({
  ...contextCommonShape,
  occurredAt: z.string().datetime({ offset: true }),
  entityId: z.string().min(1).nullable(),
  entityLabel: z.string().min(1).nullable(),
  authority: contextAuthoritySchema,
  evidence: z.array(contextEvidenceRefSchema),
}).strict();
export const contextCorrectionRecordSchema = z.object({
  ...contextCommonShape,
  action: z.enum(['assert', 'reject']),
  authority: contextAuthoritySchema,
  evidence: z.array(contextEvidenceRefSchema),
}).strict();
export const contextEntitySchema = z.object({ ...contextCommonShape }).strict();
export const contextDerivedItemSchema = z.object({
  ...contextCommonShape,
  type: contextDerivedItemTypeSchema,
  authority: contextAuthoritySchema,
  evidence: z.array(contextEvidenceRefSchema),
  review: z.enum(['proposed', 'conflicted', 'confirmed']),
  correctable: z.boolean(),
  correctionDisabledReason: z.enum(['pending_review', 'conflicted']).nullable(),
}).strict().superRefine((value, context) => {
  if (value.correctable !== (value.review === 'confirmed')) {
    context.addIssue({ code: 'custom', message: 'only confirmed items are correctable', path: ['correctable'] });
  }
  const expectedReason = value.review === 'confirmed' ? null
    : value.review === 'conflicted' ? 'conflicted' : 'pending_review';
  if (value.correctionDisabledReason !== expectedReason) {
    context.addIssue({ code: 'custom', message: 'correctionDisabledReason does not match review', path: ['correctionDisabledReason'] });
  }
});
export const contextProfileAttributeSchema = z.object({
  ...contextCommonShape,
  type: contextProfileFacetTypeSchema,
  authority: contextAuthoritySchema,
  evidence: z.array(contextEvidenceRefSchema),
  conflict: z.string().min(1).nullable(),
  review: contextReviewStateSchema.nullable(),
}).strict();
export const contextEntityDetailSchema = z.object({
  ...contextCommonShape,
  correctionRevisions: z.object({
    personal: z.number().int().nonnegative(),
    organization: z.number().int().nonnegative(),
  }).strict(),
  evidence: z.array(contextEvidenceRefSchema),
  items: z.array(contextDerivedItemSchema),
  corrections: z.array(contextCorrectionRecordSchema),
}).strict();
export const contextEntityProfileSchema = z.object({
  entityId: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1).nullable(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true }),
  attributes: z.array(contextProfileAttributeSchema),
  degraded: z.boolean(),
}).strict();
const contextRelationEntitySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  summary: z.string().min(1).nullable(),
}).strict();
export const contextRelationSchema = z.object({
  ...contextCommonShape,
  depth: z.union([z.literal(1), z.literal(2)]),
  level: z.enum(['explicit', 'cooccurrence', 'inferred']),
  reviewStatus: z.enum(['proposed', 'confirmed', 'rejected']),
  fromEntity: contextRelationEntitySchema,
  targetEntity: contextRelationEntitySchema,
  authority: contextAuthoritySchema,
  evidence: z.array(contextEvidenceRefSchema),
}).strict();
export const contextReviewItemSchema = z.object({
  ...contextCommonShape,
  entityId: z.string().min(1),
  entityLabel: z.string().min(1),
  status: contextReviewStateSchema,
  originalSummary: z.string().min(1).nullable(),
  proposedSummary: z.string().min(1),
  conflict: z.string().min(1).nullable(),
  authority: contextAuthoritySchema,
  evidence: z.array(contextEvidenceRefSchema),
}).strict();
export const contextReviewDecisionResponseSchema = z.object({
  status: z.enum(['confirmed', 'rejected']),
}).strict();
export const contextProductDiagnosisSchema = z.object({
  code: z.enum(['scope_empty', 'no_source_records', 'no_visible_records', 'native_acl_filtered',
    'candidate_limit_reached', 'projection_missing', 'query_no_match', 'source_degraded']),
  stage: z.enum(['assignment', 'ingestion', 'authorization', 'projection', 'query', 'source']),
  message: z.string().min(1),
  action: z.string().min(1),
  scannedCandidates: z.number().int().nonnegative().optional(),
  deniedCandidates: z.number().int().nonnegative().optional(),
}).strict();
const pageOf = <T extends z.ZodTypeAny>(item: T) => z.object({
  items: z.array(item),
  nextCursor: z.string().min(1).nullable(),
  degraded: z.boolean(),
  diagnosis: contextProductDiagnosisSchema.optional(),
}).strict();
export const contextTimelinePageSchema = pageOf(contextTimelineItemSchema);
export const contextEntityPageSchema = pageOf(contextEntitySchema);
export const contextEntityItemPageSchema = pageOf(contextDerivedItemSchema);
export const contextCorrectionPageSchema = pageOf(contextCorrectionRecordSchema);
export const contextRelationPageSchema = pageOf(contextRelationSchema);
export const contextReviewPageSchema = pageOf(contextReviewItemSchema);

export type ContextEvidenceRefDto = z.infer<typeof contextEvidenceRefSchema>;
export type ContextTimelinePageDto = z.infer<typeof contextTimelinePageSchema>;
export type ContextEntityPageDto = z.infer<typeof contextEntityPageSchema>;
export type ContextEntityItemPageDto = z.infer<typeof contextEntityItemPageSchema>;
export type ContextCorrectionPageDto = z.infer<typeof contextCorrectionPageSchema>;
export type ContextDerivedItemDto = z.infer<typeof contextDerivedItemSchema>;
export type ContextProfileAttributeDto = z.infer<typeof contextProfileAttributeSchema>;
export type ContextEntityDetailDto = z.infer<typeof contextEntityDetailSchema>;
export type ContextEntityProfileDto = z.infer<typeof contextEntityProfileSchema>;
export type ContextRelationPageDto = z.infer<typeof contextRelationPageSchema>;
export type ContextReviewPageDto = z.infer<typeof contextReviewPageSchema>;
export type ContextCorrectionRecordDto = z.infer<typeof contextCorrectionRecordSchema>;
export type ContextReviewItemDto = z.infer<typeof contextReviewItemSchema>;
export type ContextReviewDecisionResponseDto = z.infer<typeof contextReviewDecisionResponseSchema>;

export interface ContextListQuery { cursor?: string; filter?: string; type?: string }
export interface ContextTimelineQuery extends ContextListQuery { entityId?: string; from?: string; through?: string }
export interface ContextRelationQuery extends ContextListQuery { depth?: 1 | 2 }
export type ContextCorrectionCommand = {
  action: 'assert';
  scope: 'personal' | 'organization';
  expectedRevision: number;
  targetItemId: string;
  summary: string;
  evidenceIds: string[];
} | {
  action: 'reject';
  scope: 'personal' | 'organization';
  expectedRevision: number;
  targetItemId: string;
  summary?: string;
  evidenceIds: string[];
};
export interface ContextReviewDecisionCommand {
  decision: 'confirm' | 'reject';
  expectedRevision: number;
}
const contextCorrectionBaseShape = {
  scope: z.enum(['personal', 'organization']),
  expectedRevision: z.number().int().positive(),
  targetItemId: z.string().trim().min(1).max(500),
  evidenceIds: z.array(z.string().min(1).max(2_000)).min(1).max(50),
};
const contextCorrectionCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assert'), ...contextCorrectionBaseShape, summary: z.string().trim().min(1).max(500) }).strict(),
  z.object({ action: z.literal('reject'), ...contextCorrectionBaseShape, summary: z.string().trim().min(1).max(500).optional() }).strict(),
]);
const contextReviewDecisionCommandSchema = z.object({
  decision: z.enum(['confirm', 'reject']), expectedRevision: z.number().int().positive(),
}).strict();

async function contextPlaneRequest<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  try {
    return await request(path, init, schema);
  } catch (cause) {
    if (cause instanceof GovernanceApiError && cause.status === 403) {
      throw new GovernanceApiError('CONTEXT_PLANE_FORBIDDEN', '当前账号无权查看 Context Center。', 403);
    }
    if (cause instanceof GovernanceApiError && cause.status === 404) {
      throw new GovernanceApiError('CONTEXT_PLANE_UNAVAILABLE', 'Context Center 服务端能力尚未提供。', 404);
    }
    if (cause instanceof GovernanceApiError && cause.status === 409) {
      throw new GovernanceApiError('CONTEXT_REVISION_CONFLICT', '内容版本已变化，请刷新实体详情后重试。', 409);
    }
    if (cause instanceof GovernanceApiError && cause.status === 503) {
      throw new GovernanceApiError('CONTEXT_PLANE_UNAVAILABLE', 'Context Center 服务暂不可用，请稍后重试。', 503);
    }
    throw cause;
  }
}

const contextQuery = (tenantId: string | undefined, query?: ContextListQuery) => ({
  tenantId, cursor: query?.cursor, filter: query?.filter, type: query?.type,
});

/** Organization-admin Context Plane adapter. Every response is parsed by a strict UI-safe schema. */
export const contextCenterApi = {
  getSnapshot: (options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery('/api/admin/context-plane/snapshot', { tenantId: options?.tenantId }),
    contextCenterSnapshotSchema, options?.signal ? { signal: options.signal } : undefined,
  ),
  getEvidence: (evidenceId: string, options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery('/api/admin/context-plane/evidence', { id: evidenceId, tenantId: options?.tenantId }),
    contextEvidenceListSchema, options?.signal ? { signal: options.signal } : undefined,
  ),
  listTimeline: (query: ContextTimelineQuery = {}, options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery('/api/admin/context-plane/timeline', {
      ...contextQuery(options?.tenantId, query), entityId: query.entityId, from: query.from, through: query.through,
    }), contextTimelinePageSchema, options?.signal ? { signal: options.signal } : undefined,
  ),
  listEntities: (query: ContextListQuery = {}, options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery('/api/admin/context-plane/entities', contextQuery(options?.tenantId, query)),
    contextEntityPageSchema, options?.signal ? { signal: options.signal } : undefined,
  ),
  getEntity: (entityId: string, options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery(`/api/admin/context-plane/entities/${id(entityId)}`, { tenantId: options?.tenantId }),
    contextEntityDetailSchema, options?.signal ? { signal: options.signal } : undefined,
  ),
  listEntityItems: (entityId: string, query: ContextListQuery = {}, options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery(`/api/admin/context-plane/entities/${id(entityId)}/items`, contextQuery(options?.tenantId, query)),
    contextEntityItemPageSchema, options?.signal ? { signal: options.signal } : undefined,
  ),
  listEntityCorrections: (entityId: string, query: ContextListQuery = {}, options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery(`/api/admin/context-plane/entities/${id(entityId)}/corrections`, contextQuery(options?.tenantId, query)),
    contextCorrectionPageSchema, options?.signal ? { signal: options.signal } : undefined,
  ),
  getEntityProfile: (entityId: string, options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery(`/api/admin/context-plane/entities/${id(entityId)}/profile`, { tenantId: options?.tenantId }),
    contextEntityProfileSchema, options?.signal ? { signal: options.signal } : undefined,
  ),
  listEntityRelations: (entityId: string, query: ContextRelationQuery = {}, options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery(`/api/admin/context-plane/entities/${id(entityId)}/relations`, {
      ...contextQuery(options?.tenantId, query), depth: query.depth,
    }),
    contextRelationPageSchema, options?.signal ? { signal: options.signal } : undefined,
  ),
  listReviews: (query: ContextListQuery = {}, options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery('/api/admin/context-plane/reviews', contextQuery(options?.tenantId, query)),
    contextReviewPageSchema, options?.signal ? { signal: options.signal } : undefined,
  ),
  createCorrection: (entityId: string, command: ContextCorrectionCommand, options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery(`/api/admin/context-plane/entities/${id(entityId)}/corrections`, { tenantId: options?.tenantId }),
    contextCorrectionRecordSchema,
    { ...body('POST', contextCorrectionCommandSchema.parse(command)), ...(options?.signal ? { signal: options.signal } : {}) },
  ),
  decideReview: (itemId: string, command: ContextReviewDecisionCommand, options?: { signal?: AbortSignal; tenantId?: string }) => contextPlaneRequest(
    withQuery(`/api/admin/context-plane/reviews/${id(itemId)}/decision`, { tenantId: options?.tenantId }),
    contextReviewDecisionResponseSchema,
    { ...body('POST', contextReviewDecisionCommandSchema.parse(command)), ...(options?.signal ? { signal: options.signal } : {}) },
  ),
};

/** Existing /api/governance/access endpoints. Raw records remain fail-closed and UI-safe. */
export const governanceAccessApi = {
  getProjection: <T = unknown>(projectionId: string) =>
    request<T>(`${ACCESS_BASE}/projections/${id(projectionId)}`),
  listOAuthGrants: () => request(`${ACCESS_BASE}/oauth-grants`, undefined, oauthGrantResponseSchema),
  previewOAuthGrantRevocation: (grantId: string, reason: string) =>
    request(`${ACCESS_BASE}/oauth-grants/${id(grantId)}/revoke/preview`, body('POST', { reason }), oauthRevocationPreviewSchema),
  revokeOAuthGrant: (grantId: string, command: GovernanceCommand) =>
    request(`${ACCESS_BASE}/oauth-grants/${id(grantId)}/revoke`, body('POST', command), oauthRevocationResultSchema),
  listMemberships: <T = unknown>(tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/memberships`, tenant(tenantId)), undefined, schemaFor<T>(membershipListSchema)),
  createMembership: <T = unknown>(command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/memberships`, tenant(tenantId)), body('POST', command)),
  getMembershipDetails: <T = unknown>(userId: string, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/memberships/${id(userId)}/details`, tenant(tenantId)), undefined, schemaFor<T>(memberDetailsSchema)),
  createTenant: <T = unknown>(command: { id: string; name: string }) =>
    request<T>(`${ACCESS_BASE}/tenants`, body('POST', command)),
  getTenantSettings: <T = unknown>(tenantId: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/tenant-settings`, { tenantId })),
  updateTenantSettings: <T = unknown>(tenantId: string, command: GovernanceCommand) =>
    request<T>(withQuery(`${ACCESS_BASE}/tenant-settings`, { tenantId }), body('PUT', command)),
  getTenantLifecycle: <T = unknown>(tenantId: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/tenant-lifecycle`, { tenantId }), undefined, schemaFor<T>(lifecycleResponseSchema)),
  previewTenantLifecycle: <T = unknown>(tenantId: string, command: GovernanceCommand) =>
    request<T>(withQuery(`${ACCESS_BASE}/tenant-lifecycle/preview`, { tenantId }), body('POST', command), schemaFor<T>(lifecyclePreviewSchema)),
  updateTenantLifecycle: <T = unknown>(tenantId: string, command: GovernanceCommand) =>
    request<T>(
      withQuery(`${ACCESS_BASE}/tenant-lifecycle`, { tenantId }),
      body('POST', command),
      schemaFor<T>(lifecycleMutationReceiptSchema),
      LIFECYCLE_MUTATION_SUCCESS_CODES,
    ),
  listDirectoryGroups: <T = unknown>(tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/directory-groups`, tenant(tenantId)), undefined, schemaFor<T>(directoryGroupListSchema)),
  previewMembership: <T = unknown>(userId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/memberships/${id(userId)}/preview`, tenant(tenantId)), body('POST', command), schemaFor<T>(membershipPreviewSchema)),
  updateMembership: <T = unknown>(userId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/memberships/${id(userId)}`, tenant(tenantId)), body('PATCH', command), schemaFor<T>(governanceReceiptSchema)),
  listPlatformAdmins: <T = unknown>() => request<T>(`${ACCESS_BASE}/platform-admins`, undefined, schemaFor<T>(platformAdminListSchema)),
  updatePlatformAdmin: <T = unknown>(userId: string, command: GovernanceCommand) =>
    request<T>(`${ACCESS_BASE}/platform-admins/${id(userId)}`, body('PATCH', command)),
  listAuditEvents: <T = unknown>(query?: { tenantId?: string; before?: string; limit?: number }) =>
    request<T>(withQuery(`${ACCESS_BASE}/audit-events`, query), undefined, schemaFor<T>(auditListSchema)),
  getEntitlements: <T = unknown>(tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/entitlements`, tenant(tenantId)), undefined, schemaFor<T>(entitlementResponseSchema)),
  previewEntitlements: <T = unknown>(command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/entitlements/preview`, tenant(tenantId)), body('POST', command), schemaFor<T>(entitlementPreviewSchema)),
  updateEntitlements: <T = unknown>(command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/entitlements`, tenant(tenantId)), body('PATCH', command), schemaFor<T>(governanceReceiptSchema)),
  previewEntitlementScope: <T = unknown>(resourceType: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/entitlement-scopes/${id(resourceType)}/preview`, tenant(tenantId)), body('POST', command), schemaFor<T>(scopePreviewSchema)),
  updateEntitlementScope: <T = unknown>(resourceType: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/entitlement-scopes/${id(resourceType)}`, tenant(tenantId)), body('PUT', command), schemaFor<T>(governanceReceiptSchema)),
  previewPolicy: <T = unknown>(policyKey: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/policies/${id(policyKey)}/preview`, tenant(tenantId)), body('POST', command), schemaFor<T>(policyPreviewSchema)),
  updatePolicy: <T = unknown>(policyKey: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/policies/${id(policyKey)}`, tenant(tenantId)), body('PUT', command), schemaFor<T>(governanceReceiptSchema)),
  listMemoryKnowledge: <T = unknown>(tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/organization-resources/memory-knowledge`, {
      ...tenant(tenantId), includeSuites: '1',
    }), undefined, schemaFor<T>(memoryKnowledgeListSchema)),
  previewMemoryResource: <T = unknown>(command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/organization-resources/memory/preview`, tenant(tenantId)), body('POST', command), schemaFor<T>(memoryResourcePreviewSchema)),
  updateMemoryResource: <T = unknown>(resourceId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/organization-resources/memory/${id(resourceId)}`, tenant(tenantId)), body('PUT', command)),
  getAssignment: <T = unknown>(resourceType: string, resourceId: string, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/assignments/${id(resourceType)}/${id(resourceId)}`, tenant(tenantId))),
  previewAssignment: <T = unknown>(resourceType: string, resourceId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/assignments/${id(resourceType)}/${id(resourceId)}/preview`, tenant(tenantId)), body('POST', command)),
  updateAssignment: <T = unknown>(resourceType: string, resourceId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/assignments/${id(resourceType)}/${id(resourceId)}`, tenant(tenantId)), body('PUT', command)),
  previewAssignmentBatch: <T = unknown>(command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/assignments/batch/preview`, tenant(tenantId)), body('POST', command),
      schemaFor<T>(assignmentBatchPreviewSchema)),
  updateAssignmentBatch: <T = unknown>(command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${ACCESS_BASE}/assignments/batch`, tenant(tenantId)), body('PUT', command),
      schemaFor<T>(assignmentBatchReceiptSchema)),
  listContentGrants: <T = unknown>(query?: Record<string, QueryValue>) =>
    request<T>(withQuery(`${ACCESS_BASE}/content-grants`, query)),
  createContentGrant: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${ACCESS_BASE}/content-grants`, body('POST', command)),
  revokeContentGrant: <T = unknown>(grantId: string, command: GovernanceCommand = {}) =>
    request<T>(`${ACCESS_BASE}/content-grants/${id(grantId)}/revoke`, body('POST', command)),
  listPreferences: <T = unknown>() => request<T>(`${ACCESS_BASE}/preferences`),
  updatePreference: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${ACCESS_BASE}/preferences`, body('PUT', command)),
};

/** Existing /api/governance/resources endpoints. */
export const governanceResourcesApi = {
  listAgentTemplates: <T = unknown>() =>
    request<T>(withQuery(`${RESOURCE_BASE}/agents`, { kind: 'agent_template' }), undefined, schemaFor<T>(agentListSchema)),
  listEntitlementResourceCatalog: <T = unknown>(resourceType: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/entitlement-resource-catalog`, { resourceType }), undefined, schemaFor<T>(entitlementCatalogSchema)),
  getAgent: <T = unknown>(agentId: string, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/agents/${id(agentId)}`, tenant(tenantId))),
  getSkill: <T = unknown>(skillId: string) => request<T>(`${RESOURCE_BASE}/skills/${id(skillId)}`),
  listConnectors: <T = unknown>() => request<T>(`${RESOURCE_BASE}/connectors`),
  listCredentials: <T = unknown>(tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/credentials`, tenant(tenantId)), undefined, schemaFor<T>(credentialListSchema)),
  getEnvironmentProvider: <T = unknown>(providerId: string) =>
    request<T>(`${RESOURCE_BASE}/environment/providers/${id(providerId)}`),
  getEnvironmentTemplate: <T = unknown>(templateId: string) =>
    request<T>(`${RESOURCE_BASE}/environment/templates/${id(templateId)}`),
  createAgent: <T = unknown>(command: GovernanceCommand) => request<T>(`${RESOURCE_BASE}/agents`, body('POST', command)),
  previewAgentVersion: <T = unknown>(agentId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/agents/${id(agentId)}/versions/preview`, body('POST', command)),
  publishAgentVersion: <T = unknown>(agentId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/agents/${id(agentId)}/versions`, body('POST', command)),
  updateAgentStatus: <T = unknown>(agentId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/agents/${id(agentId)}/status`, body('PATCH', command)),
  archiveAgent: <T = unknown>(agentId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/agents/${id(agentId)}/archive`, body('POST', command)),
  importTenantSkillPackage: (tenantId: string, files: File[]) => {
    const formData = new FormData();
    for (const file of files) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      formData.append('files', file, relativePath);
    }
    return request<GovernanceSkillImportResponse>(
      withQuery(`${RESOURCE_BASE}/skills/import`, { scope: 'tenant', tenantId }),
      { method: 'POST', body: formData },
    );
  },
  importPersonalSkillPackage: (files: File[]) => {
    const formData = new FormData();
    for (const file of files) {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      formData.append('files', file, relativePath);
    }
    return request<GovernanceSkillImportResponse>(
      withQuery(`${RESOURCE_BASE}/skills/import`, { scope: 'personal' }),
      { method: 'POST', body: formData },
    );
  },
  createSkill: <T = unknown>(command: GovernanceCommand) => request<T>(`${RESOURCE_BASE}/skills`, body('POST', command)),
  publishSkillVersion: <T = unknown>(skillId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/skills/${id(skillId)}/versions`, body('POST', command)),
  createSkillCandidate: <T = unknown>(skillId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/skills/${id(skillId)}/candidates`, body('POST', command)),
  submitSkillCandidate: <T = unknown>(candidateId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/skill-candidates/${id(candidateId)}/submit`, body('POST', command)),
  reviewSkillCandidate: <T = unknown>(candidateId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/skill-candidates/${id(candidateId)}/review`, body('POST', command)),
  publishSkillCandidate: <T = unknown>(candidateId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/skill-candidates/${id(candidateId)}/publish`, body('POST', command)),
  publishConnectorVersion: <T = unknown>(connectorId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/connectors/${id(connectorId)}/versions`, body('POST', command)),
  updateConnectorStatus: <T = unknown>(connectorId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/connectors/${id(connectorId)}/status`, body('PATCH', command)),
  previewCredentialCreate: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/credentials/preview`, body('POST', command), schemaFor<T>(credentialOperationPreviewSchema)),
  createCredential: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/credentials`, body('POST', command)),
  previewCredentialRotation: <T = unknown>(credentialId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/credentials/${id(credentialId)}/rotate/preview`, tenant(tenantId)), body('POST', command), schemaFor<T>(credentialOperationPreviewSchema)),
  rotateCredential: <T = unknown>(credentialId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/credentials/${id(credentialId)}/rotate`, tenant(tenantId)), body('POST', command)),
  previewCredentialRevoke: <T = unknown>(credentialId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/credentials/${id(credentialId)}/revoke/preview`, tenant(tenantId)), body('POST', command), schemaFor<T>(credentialOperationPreviewSchema)),
  revokeCredential: <T = unknown>(credentialId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/credentials/${id(credentialId)}/revoke`, tenant(tenantId)), body('POST', command)),
  previewCredentialTransfer: <T = unknown>(credentialId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/credentials/${id(credentialId)}/transfer/preview`, tenant(tenantId)), body('POST', command), schemaFor<T>(credentialOperationPreviewSchema)),
  transferCredential: <T = unknown>(credentialId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/credentials/${id(credentialId)}/transfer`, tenant(tenantId)), body('POST', command)),
  testCredentialHealth: <T = unknown>(credentialId: string, expectedVersion: number, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/credentials/${id(credentialId)}/health-test`, tenant(tenantId)), body('POST', { expectedVersion })),
  updateCredentialStatus: <T = unknown>(credentialId: string, command: GovernanceCommand, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/credentials/${id(credentialId)}/status`, tenant(tenantId)), body('PATCH', command)),
  updateEnvironmentProvider: <T = unknown>(providerId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/environment/providers/${id(providerId)}`, body('PUT', command)),
  listEnvironmentTemplates: <T = unknown>() =>
    request<T>(`${RESOURCE_BASE}/environment/templates`, undefined, schemaFor<T>(environmentTemplateListSchema)),
  publishEnvironmentTemplate: <T = unknown>(templateId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/environment/templates/${id(templateId)}/versions`, body('POST', command)),
  retireEnvironmentTemplate: <T = unknown>(templateId: string, command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/environment/templates/${id(templateId)}/retire`, body('POST', command)),
  getChangeJob: <T = unknown>(jobId: string, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/change-jobs/${id(jobId)}`, tenant(tenantId)), undefined, schemaFor<T>(changeJobSchema)),
  retryChangeJob: <T = unknown>(jobId: string, expectedRevision: number, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/change-jobs/${id(jobId)}/retry`, tenant(tenantId)), body('POST', { expectedRevision }), schemaFor<T>(changeJobSchema)),
  previewResourceRetirement: <T = unknown>(targetType: string, targetId: string, tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/previews/resource-retirement`, { targetType, targetId, tenantId })),
  previewCredentialChange: <T = unknown>(credentialId: string, action: 'suspend' | 'revoke', tenantId?: string) =>
    request<T>(withQuery(`${RESOURCE_BASE}/previews/credentials/${id(credentialId)}`, { action, tenantId })),
  previewUserOffboarding: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/previews/user-offboarding`, body('POST', command), schemaFor<T>(offboardingPreviewSchema)),
  startUserOffboarding: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/change-jobs/user-offboarding`, body('POST', command), schemaFor<T>(changeJobSchema)),
  previewTenantDelete: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/previews/tenant-delete`, body('POST', command)),
  startTenantDelete: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/change-jobs/tenant-delete`, body('POST', command)),
  startResourceRetirement: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/change-jobs/resource-retire`, body('POST', command)),
  startCredentialRevoke: <T = unknown>(command: GovernanceCommand) =>
    request<T>(`${RESOURCE_BASE}/change-jobs/credential-revoke`, body('POST', command)),
};

export async function fetchManagementSnapshot(
  command: ManagementSnapshotRequestV1,
): Promise<ManagementSnapshotResponseV1> {
  const requestBody = managementSnapshotRequestV1Schema.parse(command);
  return request(
    '/api/access/management-snapshot',
    body('POST', requestBody),
    managementSnapshotResponseV1Schema,
  );
}

/** Planned authoritative endpoints. These never infer an allow result locally. */
export async function evaluateAccess(command: GovernanceCommand): Promise<EffectiveResourceView[]> {
  return request('/api/access/evaluate', body('POST', command), z.array(effectiveResourceViewSchema));
}

export async function fetchAccessDecision(decisionId: string): Promise<AccessDecision> {
  return request(`/api/access/decisions/${id(decisionId)}`, undefined, accessDecisionSchema);
}

export async function preflightExecution(command: GovernanceCommand): Promise<ExecutionReadiness> {
  return request('/api/execution/preflight', body('POST', command), executionReadinessSchema);
}

export interface MyGovernanceSummary {
  persona: 'platform_admin' | 'org_admin' | 'member';
  label: string;
  desktopPath: string;
  attention: { status: 'desktop_required' | 'none' };
}

export async function fetchMyGovernanceSummary(): Promise<MyGovernanceSummary> {
  return request('/api/me/governance-summary', undefined, z.object({
    persona: z.enum(['platform_admin', 'org_admin', 'member']),
    label: z.string().min(1), desktopPath: z.string().startsWith('/'),
    attention: z.object({ status: z.enum(['desktop_required', 'none']) }).strict(),
  }).strict());
}

export async function fetchEffectiveResources(domains: string[] = []): Promise<EffectiveResourceView[]> {
  const path = withQuery('/api/me/effective-resources', {
    domains: domains.length ? domains.join(',') : undefined,
  });
  return request(path, undefined, z.array(effectiveResourceViewSchema));
}
