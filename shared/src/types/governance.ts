import { z } from 'zod';

/** Wire contract generation. Breaking changes require a new schema/type suffix. */
export const GOVERNANCE_CONTRACT_VERSION = 'v1' as const;

const nonEmpty = z.string().min(1);
const timestamp = z.iso.datetime({ offset: true });
const uiHref = nonEmpty.refine(
  (value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('\\'),
  'href must be a site-relative path',
);

export const governanceDomainSchema = z.enum([
  'agent', 'skill', 'connector', 'memory', 'file', 'automation', 'model_tool', 'environment',
]);
export const governancePersonaSchema = z.enum(['platform_admin', 'org_admin', 'member']);
export const accessStateSchema = z.enum([
  'allowed', 'denied', 'needs_assignment', 'needs_user_authorization',
  'runtime_approval_required',
]);
export const accessLayerSchema = z.enum([
  'invariant', 'entitlement', 'persona', 'tenant_policy', 'assignment',
  'long_term_grant', 'runtime_approval',
]);
export const nextActionCodeSchema = z.enum([
  'use', 'authorize', 'view_reason', 'contact_admin', 'retry',
]);
export const readinessBlockerCodeSchema = z.enum([
  'RESOURCE_DISABLED', 'RESOURCE_RETIRED', 'CREDENTIAL_MISSING',
  'CREDENTIAL_EXPIRED', 'CREDENTIAL_UNHEALTHY', 'QUOTA_EXHAUSTED',
  'RUN_LIMIT_REACHED', 'ENVIRONMENT_UNAVAILABLE', 'PROVIDER_DRAINING',
  'MODEL_UNAVAILABLE',
]);
export const primaryResultCodeSchema = z.enum([
  'unavailable', 'blocked_lifecycle', 'needs_assignment', 'needs_authorization',
  'needs_runtime_approval', 'not_ready', 'available',
]);

export const resourceRefSchema = z.object({
  type: nonEmpty,
  id: nonEmpty,
  tenantId: nonEmpty.optional(),
  displayName: nonEmpty,
  domain: governanceDomainSchema,
}).strict();

export const resourceLifecycleSchema = z.object({
  state: nonEmpty,
  blocksNewUse: z.boolean(),
  effectiveAt: timestamp.optional(),
  reasonCode: nonEmpty.optional(),
}).strict();

export const nextActionSchema = z.object({
  code: nextActionCodeSchema,
  label: nonEmpty,
  href: uiHref.optional(),
}).strict();

export const permissionReasonSchema = z.object({
  code: nonEmpty,
  label: nonEmpty,
  layer: accessLayerSchema,
  sourceVersion: nonEmpty.optional(),
}).strict();

export const accessChainStepSchema = z.object({
  layer: accessLayerSchema,
  result: z.enum(['pass', 'deny', 'condition', 'not_applicable']),
  code: nonEmpty,
  label: nonEmpty,
  sourceVersion: nonEmpty.optional(),
}).strict();

export const accessDecisionSchema = z.object({
  decisionId: nonEmpty,
  verdict: z.enum(['allow', 'deny', 'conditional']),
  accessState: accessStateSchema,
  action: nonEmpty,
  subject: z.object({
    subjectId: nonEmpty,
    tenantId: nonEmpty,
    persona: governancePersonaSchema,
    isOwner: z.boolean(),
  }).strict(),
  resource: resourceRefSchema,
  decisiveLayer: accessLayerSchema,
  reasonCode: nonEmpty,
  reason: nonEmpty,
  chain: z.array(accessChainStepSchema),
  policySnapshot: z.object({
    membershipVersion: z.number().int().nonnegative(),
    entitlementVersion: z.number().int().nonnegative().optional(),
    tenantPolicyVersion: z.number().int().nonnegative().optional(),
    assignmentVersion: z.number().int().nonnegative().optional(),
    grantGeneration: z.number().int().nonnegative().optional(),
  }).strict(),
  nextActions: z.array(nextActionSchema),
  evaluatedAt: timestamp,
}).strict().superRefine((value, ctx) => {
  const invalid = (value.verdict === 'allow' && value.accessState !== 'allowed')
    || (value.verdict === 'conditional' && value.accessState !== 'runtime_approval_required')
    || (value.verdict === 'deny'
      && (value.accessState === 'allowed' || value.accessState === 'runtime_approval_required'));
  if (invalid) {
    ctx.addIssue({
      code: 'custom',
      path: ['accessState'],
      message: 'accessState is inconsistent with verdict',
    });
  }
});

export const executionReadinessSchema = z.object({
  ready: z.boolean(),
  evaluatedAt: timestamp,
  blockers: z.array(z.object({
    code: readinessBlockerCodeSchema,
    message: nonEmpty,
    retryable: z.boolean(),
    nextAction: nextActionSchema.optional(),
  }).strict()),
  resolved: z.object({
    credentialId: nonEmpty.optional(),
    credentialGeneration: z.number().int().nonnegative().optional(),
    environmentTemplateVersionId: nonEmpty.optional(),
    providerId: nonEmpty.optional(),
    modelRef: nonEmpty.optional(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.ready === (value.blockers.length > 0)) {
    ctx.addIssue({
      code: 'custom',
      path: ['blockers'],
      message: 'ready must be true exactly when blockers is empty',
    });
  }
});

export const PRIMARY_RESULT_PRIORITY = [
  'unavailable', 'blocked_lifecycle', 'needs_assignment', 'needs_authorization',
  'needs_runtime_approval', 'not_ready', 'available',
] as const;

/** Validation helper only: UI must render the server-provided primaryResult. */
export function expectedPrimaryResultCode(axes: {
  lifecycle: { blocksNewUse: boolean };
  access: { accessState: z.infer<typeof accessStateSchema> };
  readiness?: { ready: boolean };
}): z.infer<typeof primaryResultCodeSchema> {
  if (axes.access.accessState === 'denied') return 'unavailable';
  if (axes.lifecycle.blocksNewUse) return 'blocked_lifecycle';
  if (axes.access.accessState === 'needs_assignment') return 'needs_assignment';
  if (axes.access.accessState === 'needs_user_authorization') return 'needs_authorization';
  if (axes.access.accessState === 'runtime_approval_required') return 'needs_runtime_approval';
  if (axes.readiness && !axes.readiness.ready) return 'not_ready';
  return 'available';
}

export const threeAxisStateSchema = z.object({
  lifecycle: resourceLifecycleSchema,
  access: accessDecisionSchema,
  readiness: executionReadinessSchema.optional(),
}).strict();

export const effectiveResourceViewSchema = z.object({
  resource: resourceRefSchema,
  lifecycle: resourceLifecycleSchema,
  access: accessDecisionSchema,
  readiness: executionReadinessSchema.optional(),
  primaryResult: z.object({ code: primaryResultCodeSchema, label: nonEmpty }).strict(),
  decisiveFactor: z.object({ code: nonEmpty, label: nonEmpty }).strict(),
}).strict().superRefine((value, ctx) => {
  const expected = expectedPrimaryResultCode(value);
  if (value.primaryResult.code !== expected) {
    ctx.addIssue({
      code: 'custom',
      path: ['primaryResult', 'code'],
      message: `primary result must be ${expected}`,
    });
  }
});

export const changeImpactItemSchema = z.object({
  type: nonEmpty,
  id: nonEmpty,
  label: nonEmpty,
}).strict();

export const changePreviewSchema = z.object({
  previewId: nonEmpty,
  baselineDigest: nonEmpty,
  expiresAt: timestamp,
  immediate: z.array(changeImpactItemSchema),
  nextRun: z.array(changeImpactItemSchema),
  unaffectedCount: z.number().int().nonnegative(),
  brokenReferences: z.array(changeImpactItemSchema),
  reversible: z.boolean(),
}).strict();

export const changeReceiptSchema = z.object({
  changeId: nonEmpty,
  auditId: nonEmpty,
  effectiveAt: timestamp,
}).strict();

export const longTermGrantStateSchema = z.enum([
  'not_connected', 'authorizing', 'validating', 'connected',
  'reconnect_required', 'failed', 'revoked',
]);

export const connectionAuthorizationSchema = z.object({
  connector: resourceRefSchema,
  authMethod: nonEmpty,
  grant: z.object({
    state: longTermGrantStateSchema,
    generation: z.number().int().nonnegative().optional(),
    connectedAt: timestamp.optional(),
    expiresAt: timestamp.optional(),
    lastValidatedAt: timestamp.optional(),
    failureCode: nonEmpty.optional(),
    requestedScopes: z.array(z.object({ code: nonEmpty, label: nonEmpty }).strict()),
    purpose: nonEmpty,
    dataDestination: nonEmpty,
    revokeHelp: nonEmpty.optional(),
  }).strict(),
  effective: effectiveResourceViewSchema,
  actions: z.array(nextActionSchema),
}).strict();

export const MANAGEMENT_ACTIONS_V1 = [
  'settings.personal.view', 'settings.tenant.view', 'settings.platform.view',
] as const;
export const managementActionV1Schema = z.enum(MANAGEMENT_ACTIONS_V1);
export const managementScopeV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('personal') }).strict(),
  z.object({ kind: z.literal('tenant'), tenantId: nonEmpty.max(128) }).strict(),
  z.object({ kind: z.literal('platform') }).strict(),
]);
export const managementConstraintV1Schema = z.enum([
  'SELF_ONLY', 'SAME_TENANT_ONLY', 'EXPLICIT_TENANT_SCOPE', 'PLATFORM_ONLY',
]);
export const managementReasonCodeV1Schema = z.enum([
  'ACTION_SCOPE_MISMATCH', 'PERSONAL_SELF_ALLOWED', 'ORG_ADMIN_REQUIRED',
  'TENANT_SCOPE_MISMATCH', 'TENANT_NOT_FOUND', 'SAME_TENANT_ORG_ADMIN_ALLOWED',
  'PLATFORM_ADMIN_EXPLICIT_TENANT_ALLOWED', 'PLATFORM_TENANT_MANAGEMENT_ALLOWED',
  'PLATFORM_ADMIN_ALLOWED', 'PLATFORM_ADMIN_REQUIRED',
]);
export const managementReasonLayerV1Schema = z.enum(['management_scope', 'management_authority']);
export const managementSnapshotDecisionRequestV1Schema = z.object({
  action: managementActionV1Schema,
  scope: managementScopeV1Schema,
}).strict();
export const managementSnapshotRequestV1Schema = z.object({
  decisions: z.array(managementSnapshotDecisionRequestV1Schema).min(1).max(64),
}).strict();
export const managementSnapshotDecisionV1Schema = z.object({
  action: managementActionV1Schema,
  scope: managementScopeV1Schema,
  allowed: z.boolean(),
  reason: z.object({
    code: managementReasonCodeV1Schema,
    label: nonEmpty.max(300),
    layer: managementReasonLayerV1Schema,
  }).strict(),
  constraints: z.array(managementConstraintV1Schema).max(4)
    .refine(values => new Set(values).size === values.length, 'constraints must be unique'),
}).strict();
export const managementSnapshotResponseV1Schema = z.object({
  contractVersion: z.literal(GOVERNANCE_CONTRACT_VERSION),
  subject: z.object({
    userId: nonEmpty.max(128),
    tenantId: nonEmpty.max(128),
    persona: governancePersonaSchema,
    isOwner: z.boolean(),
  }).strict(),
  decisions: z.array(managementSnapshotDecisionV1Schema).min(1).max(64),
  policySnapshot: z.object({ membershipVersion: z.number().int().nonnegative() }).strict(),
  evaluatedAt: timestamp,
}).strict();

const forbiddenExactKeys = new Set([
  'secret', 'secretref', 'clientsecret', 'password', 'apikey', 'token', 'accesstoken',
  'refreshtoken', 'idtoken', 'authtoken', 'bearertoken', 'verifier', 'externalaccountid',
  'externalidentity', 'externaluserid', 'externalusername', 'externalaccountname', 'externalaccountemail',
]);

export function isForbiddenGovernanceField(key: string): boolean {
  return forbiddenExactKeys.has(key.replace(/[_-]/g, '').toLowerCase());
}

/** Defense in depth for generic/current endpoints and future DTOs alike. */
export function assertGovernanceUiSafe(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertGovernanceUiSafe(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (isForbiddenGovernanceField(key)) {
      throw new Error(`Governance DTO contains forbidden field at ${path}.${key}`);
    }
    assertGovernanceUiSafe(child, `${path}.${key}`);
  }
}

export function parseGovernanceDto<T>(schema: z.ZodType<T>, value: unknown): T {
  assertGovernanceUiSafe(value);
  return schema.parse(value);
}

// Stable v1 names make future breaking contract generations additive.
export const accessDecisionV1Schema = accessDecisionSchema;
export const executionReadinessV1Schema = executionReadinessSchema;
export const effectiveResourceViewV1Schema = effectiveResourceViewSchema;
export const connectionAuthorizationV1Schema = connectionAuthorizationSchema;
export const changePreviewV1Schema = changePreviewSchema;
export const changeReceiptV1Schema = changeReceiptSchema;

export type GovernanceDomain = z.infer<typeof governanceDomainSchema>;
export type GovernancePersona = z.infer<typeof governancePersonaSchema>;
export type AccessState = z.infer<typeof accessStateSchema>;
export type AccessLayer = z.infer<typeof accessLayerSchema>;
export type NextAction = z.infer<typeof nextActionSchema>;
export type PermissionReason = z.infer<typeof permissionReasonSchema>;
export type ResourceRef = z.infer<typeof resourceRefSchema>;
export type ResourceLifecycle = z.infer<typeof resourceLifecycleSchema>;
export type AccessChainStep = z.infer<typeof accessChainStepSchema>;
export type AccessDecisionV1 = z.infer<typeof accessDecisionV1Schema>;
export type ExecutionReadinessV1 = z.infer<typeof executionReadinessV1Schema>;
export type EffectiveResourceViewV1 = z.infer<typeof effectiveResourceViewV1Schema>;
export type ConnectionAuthorizationV1 = z.infer<typeof connectionAuthorizationV1Schema>;
export type ChangePreviewV1 = z.infer<typeof changePreviewV1Schema>;
export type ChangeReceiptV1 = z.infer<typeof changeReceiptV1Schema>;
export type ManagementActionV1 = z.infer<typeof managementActionV1Schema>;
export type ManagementScopeV1 = z.infer<typeof managementScopeV1Schema>;
export type ManagementConstraintV1 = z.infer<typeof managementConstraintV1Schema>;
export type ManagementReasonCodeV1 = z.infer<typeof managementReasonCodeV1Schema>;
export type ManagementReasonLayerV1 = z.infer<typeof managementReasonLayerV1Schema>;
export type ManagementSnapshotDecisionRequestV1 = z.infer<typeof managementSnapshotDecisionRequestV1Schema>;
export type ManagementSnapshotRequestV1 = z.infer<typeof managementSnapshotRequestV1Schema>;
export type ManagementSnapshotDecisionV1 = z.infer<typeof managementSnapshotDecisionV1Schema>;
export type ManagementSnapshotResponseV1 = z.infer<typeof managementSnapshotResponseV1Schema>;
export type AccessDecision = AccessDecisionV1;
export type ExecutionReadiness = ExecutionReadinessV1;
export type ThreeAxisState = z.infer<typeof threeAxisStateSchema>;
export type PrimaryResultCode = z.infer<typeof primaryResultCodeSchema>;
export type EffectiveResourceView = EffectiveResourceViewV1;
export type ChangePreview = ChangePreviewV1;
export type ChangeReceipt = ChangeReceiptV1;
export type LongTermGrantState = z.infer<typeof longTermGrantStateSchema>;
export type ConnectionAuthorization = ConnectionAuthorizationV1;
