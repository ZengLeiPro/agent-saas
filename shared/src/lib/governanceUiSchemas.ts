import { z } from 'zod';

import { isForbiddenGovernanceField } from '../types/governance';

const persistedMetadataShape = {
  createdAt: z.string().optional(), createdBy: z.string().optional(),
  updatedAt: z.string().optional(), updatedBy: z.string().optional(),
};
const mutationAuditShape = {
  changeId: z.string().min(1).optional(), auditId: z.string().min(1).optional(),
  effectiveAt: z.string().datetime({ offset: true }).optional(),
  auditCompletion: z.literal('pending').optional(), auditProjectionId: z.string().optional(),
};
const affectedResourceSchema = z.object({
  type: z.string(), id: z.string(), version: z.number().int().nonnegative(),
}).strict();

const credentialScopeSummarySchema = z.object({
  scopes: z.array(z.string().min(1).max(500)).max(100).optional(),
  operations: z.array(z.string().min(1).max(200)).max(100).optional(),
  constraints: z.array(z.string().min(1).max(500)).max(100).optional(),
  legacyCapability: z.enum(['mcp', 'connector']).optional(),
}).strict().superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if (isForbiddenGovernanceField(key)) ctx.addIssue({ code: 'custom', path: [key], message: 'scopeSummary 包含敏感字段' });
  }
});

export const actionSchema = z.object({
  id: z.string().min(1), label: z.string().min(1),
  action: z.string().optional(), change: z.record(z.string(), z.unknown()).optional(),
  resourceType: z.string().optional(), requiresReason: z.boolean().optional(),
}).strict();

export const governanceReceiptSchema = z.object({
  changeId: z.string().min(1), auditId: z.string().min(1),
  effectiveAt: z.string().datetime({ offset: true }).optional(),
  projectionStatus: z.string().optional(), projectionId: z.string().optional(),
  compatibilityProjection: z.string().optional(),
  auditCompletion: z.literal('pending').optional(), auditProjectionId: z.string().optional(),
  changed: z.boolean().optional(), userId: z.string().optional(), version: z.number().int().positive().optional(),
  tenantId: z.string().optional(), status: z.string().optional(), currentVersion: z.number().int().nonnegative().optional(),
  nextVersion: z.number().int().positive().optional(),
  persona: z.enum(['platform_admin', 'org_admin', 'member']).optional(), isOwner: z.boolean().optional(),
  source: z.string().optional(), resourceType: z.string().optional(), policyKey: z.string().optional(), value: z.unknown().optional(), mode: z.enum(['all', 'selected']).optional(),
  resourceIds: z.array(z.string()).optional(), limits: z.record(z.string(), z.number()).optional(),
  effectiveFrom: z.string().optional(), effectiveTo: z.string().optional(), updateReason: z.string().optional(),
  ...persistedMetadataShape,
}).strict();

const directoryProfileSchema = z.object({
  userId: z.string().optional(), username: z.string().min(1), displayName: z.string().min(1), position: z.string().optional(),
  accountStatus: z.enum(['active', 'disabled']), dingtalkBound: z.boolean().optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
}).strict();

export const membershipSchema = z.object({
  userId: z.string().min(1), tenantId: z.string().optional(),
  persona: z.enum(['platform_admin', 'org_admin', 'member']), isOwner: z.boolean(),
  status: z.string().min(1), source: z.string().optional(), version: z.number().int().positive(),
  ...persistedMetadataShape,
  directoryProfile: directoryProfileSchema.nullable().optional(), allowedActions: z.array(actionSchema),
}).strict();
export const membershipListSchema = z.object({ memberships: z.array(membershipSchema) }).strict();

export const membershipPreviewSchema = z.object({
  previewId: z.string().regex(/^mpv1\.[a-f0-9]{64}$/), baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }), expectedVersion: z.number().int().positive(),
  impact: z.object({
    from: z.object({ persona: z.string(), isOwner: z.boolean(), status: z.string() }).strict(),
    to: z.object({ persona: z.string(), isOwner: z.boolean(), status: z.string() }).strict(),
    blockers: z.array(z.string()), reversible: z.boolean(), effectiveMode: z.string(),
  }).strict(),
  ...mutationAuditShape,
}).strict();

const auditEventSchema = z.object({
  auditId: z.string(), correlationId: z.string().optional(), changeId: z.string().optional(),
  action: z.string(), result: z.string(), occurredAt: z.string(), actorType: z.string().optional(), actorUserId: z.string(),
  actorPersona: z.string().optional(), actorTenantId: z.string().nullable().optional(),
  targetType: z.string().optional(), targetId: z.string().optional(), targetTenantId: z.string().nullable().optional(),
  purpose: z.string().optional(), reason: z.string().optional(),
  beforeDigest: z.string().optional(), afterDigest: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const auditListSchema = z.object({ events: z.array(auditEventSchema), nextBefore: z.string().optional() }).strict();

const entitlementSchema = z.object({
  tenantId: z.string().optional(), source: z.string(), status: z.string(),
  effectiveFrom: z.string().optional(), effectiveTo: z.string().optional(),
  limits: z.record(z.string(), z.number()), version: z.number().int().positive(), updateReason: z.string().optional(),
  ...persistedMetadataShape,
}).strict();
const resourceScopeSchema = z.object({
  tenantId: z.string().optional(), resourceType: z.string(), mode: z.enum(['all', 'selected']), resourceIds: z.array(z.string()),
  source: z.string().optional(), version: z.number().int().positive(), allowedActions: z.array(actionSchema).optional(),
  ...persistedMetadataShape,
}).strict();
const policySchema = z.object({
  tenantId: z.string().optional(), policyKey: z.string(), value: z.unknown(), source: z.string(),
  version: z.number().int().positive(), allowedActions: z.array(actionSchema).optional(), ...persistedMetadataShape,
}).strict();
export const entitlementResponseSchema = z.object({
  entitlement: entitlementSchema.nullable(), scopes: z.array(resourceScopeSchema), policies: z.array(policySchema),
  allowedActions: z.array(actionSchema).optional(),
}).strict();

const previewTokenShape = {
  previewId: z.string().min(10), baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }), ...mutationAuditShape,
  changeId: z.string().min(1),
};
export const entitlementPreviewSchema = z.object({
  ...previewTokenShape,
  impact: z.object({ tenantId: z.string(), currentVersion: z.number().int().nonnegative(), nextVersion: z.number().int().positive(), fromStatus: z.string(), toStatus: z.string(), affectedResources: z.array(affectedResourceSchema).optional(), blockers: z.array(z.string()), reversible: z.boolean(), effectiveMode: z.string() }).strict(),
}).strict();
export const scopePreviewSchema = z.object({
  ...previewTokenShape,
  impact: z.object({ tenantId: z.string(), resourceType: z.string(), currentVersion: z.number().int().nonnegative(), nextVersion: z.number().int().positive(), from: z.object({ mode: z.string(), resourceCount: z.number().int().nonnegative() }).strict(), to: z.object({ mode: z.string(), resourceCount: z.number().int().nonnegative() }).strict(), affectedResources: z.array(affectedResourceSchema).optional(), blockers: z.array(z.string()), reversible: z.boolean(), effectiveMode: z.string() }).strict(),
}).strict();
export const policyPreviewSchema = z.object({
  ...previewTokenShape,
  impact: z.object({
    tenantId: z.string(), policyKey: z.string(), currentVersion: z.number().int().positive(), nextVersion: z.number().int().positive(),
    from: z.enum(['inherited', 'allow', 'deny']), to: z.enum(['allow', 'deny']), reversible: z.boolean(), effectiveMode: z.string(),
  }).strict(),
}).strict();
export const lifecycleResponseSchema = z.object({
  tenantId: z.string(), status: z.enum(['active', 'suspended']), updatedAt: z.string(),
  allowedActions: z.array(actionSchema),
}).strict();
export const lifecyclePreviewSchema = z.object({
  ...previewTokenShape,
  impact: z.object({ tenantId: z.string(), from: z.string(), to: z.string(), affectedResources: z.array(affectedResourceSchema).optional(), blockers: z.array(z.string()), reversible: z.boolean(), effectiveMode: z.string() }).strict(),
}).strict();

export const platformAdminListSchema = z.object({ platformAdmins: z.array(z.object({
  userId: z.string(), status: z.string(), source: z.string(), version: z.number().int().positive(),
  ...persistedMetadataShape, directoryProfile: directoryProfileSchema.nullable().optional(),
}).strict()) }).strict();

export const directoryGroupListSchema = z.object({
  tenantId: z.string(), groups: z.array(z.object({
    groupId: z.string(), tenantId: z.string().optional(), source: z.enum(['dingtalk', 'governance']),
    externalGroupId: z.string().optional(), displayName: z.string(), parentGroupId: z.string().optional(),
    status: z.enum(['active', 'disabled']), version: z.number().int().positive(),
    sourceRevision: z.string().optional(), projectedAt: z.string().optional(), createdAt: z.string().optional(), updatedAt: z.string().optional(),
  }).strict()),
}).strict();

const unresolvedSchema = z.object({ itemType: z.string(), itemId: z.string(), reasonCode: z.string(), retryable: z.boolean() }).strict();
const cronOwnershipSummarySchema = z.object({
  status: z.enum(['clear', 'transfer', 'unknown', 'unavailable']), ids: z.array(z.string()).optional(),
}).strict();
const personalMemorySummarySchema = z.object({
  status: z.enum(['clear', 'archive', 'unknown', 'unavailable']), ids: z.array(z.string()).optional(),
}).strict();
const fileOwnershipSummarySchema = z.object({
  status: z.enum(['clear', 'archive', 'blocked', 'unknown', 'unavailable']),
  personalFileIds: z.array(z.string()).optional(), organizationFileIds: z.array(z.string()).optional(),
}).strict();
const authoritySummarySchema = z.object({
  authority: z.enum(['available', 'unavailable']), ids: z.array(z.string()),
  snapshots: z.array(z.object({ id: z.string(), version: z.string() }).strict()),
  count: z.number().int().nonnegative(),
}).strict();
export const offboardingPreviewSchema = z.object({
  previewId: z.string().min(10), idempotencyKey: z.string().min(1), baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }), canCommit: z.boolean(), ...mutationAuditShape,
  blockers: z.array(z.object({ code: z.string(), domain: z.string(), targetId: z.string().optional() }).strict()),
  impact: z.object({
    membership: z.number().int().nonnegative(),
    agents: z.array(z.object({ id: z.string(), kind: z.string(), action: z.literal('transfer') }).strict()),
    personalAgents: z.array(z.object({ id: z.string(), action: z.literal('archive') }).strict()),
    skills: z.array(z.object({ id: z.string(), action: z.literal('retain_and_disable') }).strict()),
    personalCredentials: z.array(z.object({ id: z.string(), action: z.literal('revoke') }).strict()),
    custodialCredentials: z.array(z.object({ id: z.string(), action: z.literal('transfer_custodian') }).strict()),
    cronOwnership: cronOwnershipSummarySchema, activeRuns: authoritySummarySchema.optional(), activeSessions: authoritySummarySchema.optional(),
    oauthGrants: authoritySummarySchema.optional(), externalConnections: authoritySummarySchema.optional(), personalMemory: personalMemorySummarySchema,
    fileOwnership: fileOwnershipSummarySchema,
  }).strict(),
}).strict().superRefine((preview, context) => {
  const retentionReady = ['clear', 'transfer'].includes(preview.impact.cronOwnership.status)
    && ['clear', 'archive'].includes(preview.impact.personalMemory.status)
    && ['clear', 'archive'].includes(preview.impact.fileOwnership.status);
  if (preview.canCommit && (preview.blockers.length > 0 || !retentionReady)) {
    context.addIssue({
      code: 'custom', path: ['canCommit'],
      message: 'canCommit cannot be true while offboarding authority is unresolved or blockers remain',
    });
  }
});
export const changeJobSchema = z.object({
  job: z.object({
    jobId: z.string(), tenantId: z.string(), jobType: z.enum(['tenant_delete','resource_retire','credential_revoke','user_offboarding']),
    targetType: z.string(), targetId: z.string(), idempotencyKey: z.string(), request: z.record(z.string(), z.unknown()),
    status: z.enum(['pending','running','retry_wait','succeeded','partial','failed']), revision: z.number().int().positive(),
    attempt: z.number().int().nonnegative(), lastErrorCode: z.string().optional(), nextRetryAt: z.string().optional(),
    createdAt: z.string(), createdBy: z.string(), updatedAt: z.string(), updatedBy: z.string(), completedAt: z.string().optional(),
  }).strict(),
  domains: z.array(z.object({
    jobId: z.string(), domain: z.string(), status: z.enum(['pending','running','succeeded','failed']),
    totalCount: z.number().int().nonnegative(), completedCount: z.number().int().nonnegative(), failedCount: z.number().int().nonnegative(),
    lastErrorCode: z.string().optional(), unresolvedItems: z.array(unresolvedSchema), revision: z.number().int().positive(), updatedAt: z.string(),
  }).strict()), created: z.boolean().optional(), ...mutationAuditShape,
}).strict();

export const credentialListSchema = z.object({ credentials: z.array(z.object({
  credentialId: z.string(), tenantId: z.string().optional(), connectorId: z.string().optional(), alias: z.string().optional(),
  purpose: z.string(), kind: z.string(), status: z.string(), generation: z.number().int(), expiresAt: z.string().optional(),
  lastValidatedAt: z.string().optional(), version: z.number().int().positive(), ownerUserId: z.string().optional(),
  ownerUsername: z.string().optional(), custodianUserId: z.string().optional(),
  scopeSummary: credentialScopeSummarySchema.optional(), source: z.string().optional(), ...persistedMetadataShape,
}).strict()) }).strict();

const organizationResourceSchema = z.object({
  resourceId: z.string(), name: z.string(), status: z.enum(['enabled', 'disabled']),
  policyEnabled: z.boolean(),
  scope: z.array(z.object({ assigneeType: z.string(), assigneeId: z.string().optional(), effect: z.enum(['allow', 'deny']) }).strict()).optional(),
  effectiveAssignment: z.literal('assigned').optional(),
  source: z.string(), version: z.number().int().positive(), updatedAt: z.string(),
}).strict();

export const memoryKnowledgeListSchema = z.object({
  tenantId: z.string(), authority: z.literal('governance_assignment_sets'),
  accessMode: z.enum(['manage', 'inspect', 'effective_only']),
  knowledge: z.array(organizationResourceSchema),
  memory: z.array(organizationResourceSchema),
  effective: z.object({ organizationKnowledge: z.boolean(), organizationMemory: z.boolean() }).strict(),
}).strict();

export const memoryResourcePreviewSchema = z.object({
  previewId: z.string().regex(/^mrpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
  impact: z.object({
    operation: z.enum(['create', 'update']), resourceId: z.string(),
    currentVersion: z.number().int().nonnegative(), nextVersion: z.number().int().positive(),
    fromStatus: z.enum(['enabled', 'disabled']).nullable(), toStatus: z.enum(['enabled', 'disabled']),
    assignmentCount: z.number().int().nonnegative(), reversible: z.boolean(),
  }).strict(),
  ...mutationAuditShape,
}).strict();

export const credentialOperationPreviewSchema = z.object({
  previewId: z.string().min(10), baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }), impact: z.record(z.string(), z.unknown()),
  changeId: z.string().min(1), auditId: z.string().min(1).optional(), effectiveAt: z.string().datetime({ offset: true }).optional(),
  auditCompletion: z.literal('pending').optional(), auditProjectionId: z.string().optional(),
}).strict();

export const agentListSchema = z.object({ agents: z.array(z.object({
  agentId: z.string(), tenantId: z.string(), kind: z.enum(['org_agent','personal_agent','agent_template']), ownerUserId: z.string(),
  templateId: z.string().optional(), status: z.enum(['draft','enabled','disabled','archived']), currentVersionId: z.string().optional(),
  revision: z.number().int().positive(), createdAt: z.string(), createdBy: z.string(), updatedAt: z.string(), updatedBy: z.string(),
  archivedAt: z.string().optional(), archivedBy: z.string().optional(),
}).strict()) }).strict();
export const environmentTemplateListSchema = z.object({ templates: z.array(z.object({
  templateId: z.string(), name: z.string(), status: z.enum(['draft','published','retired']), currentVersionId: z.string().optional(),
  revision: z.number().int().positive(), createdAt: z.string(), createdBy: z.string(), updatedAt: z.string(), updatedBy: z.string(),
}).strict()) }).strict();
export const entitlementCatalogSchema = z.object({
  resourceType: z.string(), items: z.array(z.object({ resourceId: z.string(), label: z.string(), version: z.number().int().positive() }).strict()),
}).strict();

export const memberDetailsSchema = z.object({
  profile: z.object({ userId: z.string(), username: z.string(), displayName: z.string(), position: z.string().optional(), accountStatus: z.enum(['active','disabled']), dingtalkBound: z.boolean(), createdAt: z.string(), updatedAt: z.string() }).strict(),
  identity: membershipSchema,
  accessSummary: z.object({ effectivePersona: z.enum(['platform_admin','org_admin','member']), owner: z.boolean(), accountStatus: z.string(), decision: z.enum(['eligible','denied']), why: z.array(z.object({ source: z.string(), effect: z.string(), version: z.number().int() }).strict()) }).strict(),
  assignments: z.array(z.object({ resourceType: z.string(), resources: z.array(z.object({ resourceId: z.string(), bindingId: z.string(), assignmentVersion: z.number().int(), finalEffect: z.literal('allow'), bindings: z.array(z.object({ assignmentId: z.string(), assigneeType: z.string(), assigneeId: z.string().optional(), effect: z.string(), origin: z.string() }).strict()) }).strict()) }).strict()),
  usagePolicy: z.object({ status: z.literal('unavailable').optional(), tenantId: z.string().optional(), timezone: z.string().optional(), periodStart: z.string().optional(), periodEnd: z.string().optional(), items: z.array(z.object({ userId: z.string(), monthlyLimitCreditsMicro: z.number().optional(), enforcementMode: z.string(), perRunLimitCreditsMicro: z.number().optional(), active: z.boolean(), version: z.number().int(), monthAttributedCreditsMicro: z.number(), remainingCreditsMicro: z.number().optional(), canStartRun: z.boolean(), lastUsedAt: z.string().optional(), updatedBy: z.string().optional(), updatedAt: z.string().optional() }).strict()).optional() }).strict(),
  recentAudit: z.object({ events: z.array(auditEventSchema), coverage: z.string(), limit: z.number().int() }).strict(),
  snapshot: z.object({ membershipVersion: z.number().int().positive(), generatedAt: z.string() }).strict(),
}).strict();
