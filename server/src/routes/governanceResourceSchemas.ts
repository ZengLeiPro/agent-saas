import { z } from 'zod';

import { isForbiddenGovernanceField } from '../../../shared/src/types/governance.js';

const credentialScopeSummarySchema = z.object({
  scopes: z.array(z.string().min(1).max(500)).max(100).optional(),
  operations: z.array(z.string().min(1).max(200)).max(100).optional(),
  constraints: z.array(z.string().min(1).max(500)).max(100).optional(),
}).strict().superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if (isForbiddenGovernanceField(key)) ctx.addIssue({ code: 'custom', path: [key], message: 'scopeSummary 包含敏感字段' });
  }
});

export const createAgentSchema = z.object({
  tenantId: z.string().min(2).max(64).optional(), agentId: z.string().min(2).max(96).optional(),
  kind: z.enum(['org_agent', 'personal_agent', 'agent_template']), ownerUserId: z.string().min(1).max(128).optional(),
  templateId: z.string().min(2).max(96).optional(),
}).strict();
export const publishSchema = z.object({
  expectedRevision: z.number().int().positive(), definition: z.record(z.string(), z.unknown()),
}).strict();
export const statusSchema = z.object({
  expectedRevision: z.number().int().positive(), status: z.enum(['enabled', 'disabled']),
}).strict();
export const createSkillSchema = z.object({
  tenantId: z.string().min(2).max(64).optional(), skillId: z.string().min(2).max(96),
  scope: z.enum(['platform', 'tenant', 'personal']), ownerUserId: z.string().min(1).max(128).optional(),
}).strict();
export const connectorPublishSchema = z.object({
  name: z.string().min(1).max(100), authMethods: z.array(z.string().min(1).max(64)).max(20),
  capabilitySchema: z.record(z.string(), z.unknown()), definition: z.record(z.string(), z.unknown()),
}).strict();
export const connectorStatusSchema = z.object({
  expectedVersion: z.number().int().positive(), status: z.enum(['disabled', 'retired']),
}).strict();
export const credentialCreateSchema = z.object({
  tenantId: z.string().min(2).max(64).optional(), connectorId: z.string().min(1).max(96),
  kind: z.enum(['org_shared', 'personal_grant', 'infrastructure']), custodianUserId: z.string().min(1).max(128).optional(),
  alias: z.string().max(100).optional(), purpose: z.string().min(1).max(500),
  scopeSummary: credentialScopeSummarySchema.optional(), secret: z.string().min(1).max(10000),
  expiresAt: z.string().datetime().optional(),
}).strict();
export const credentialStatusSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.enum(['rotation_due', 'expired', 'suspended', 'revoked', 'validation_failed']),
  reason: z.string().min(1).max(500),
}).strict();
const credentialPreviewTokenShape = {
  previewId: z.string().regex(/^cpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
};
export const credentialCreatePreviewSchema = credentialCreateSchema.extend({
  kind: z.literal('org_shared'),
  reason: z.string().min(3).max(500),
}).strict();
export const credentialCreateCommitSchema = credentialCreatePreviewSchema.extend(credentialPreviewTokenShape).strict();
export const credentialRotatePreviewSchema = z.object({
  expectedVersion: z.number().int().positive(), secret: z.string().min(1).max(10000), reason: z.string().min(3).max(500),
}).strict();
export const credentialRotateCommitSchema = credentialRotatePreviewSchema.extend(credentialPreviewTokenShape).strict();
export const credentialTransferPreviewSchema = z.object({
  expectedVersion: z.number().int().positive(), custodianUserId: z.string().min(1).max(128), reason: z.string().min(3).max(500),
}).strict();
export const credentialTransferCommitSchema = credentialTransferPreviewSchema.extend(credentialPreviewTokenShape).strict();
export const credentialHealthSchema = z.object({ expectedVersion: z.number().int().positive() }).strict();
export const providerSchema = z.object({
  status: z.enum(['enabled', 'draining', 'disabled']), endpointRef: z.string().min(1).max(500),
  networkPolicy: z.record(z.string(), z.unknown()).optional(), infrastructureCredentialId: z.string().min(2).max(128).optional(),
  rolloutPolicy: z.record(z.string(), z.unknown()).optional(), expectedRevision: z.number().int().positive().optional(),
}).strict();
export const environmentTemplateSchema = z.object({
  name: z.string().min(1).max(100), recipe: z.record(z.string(), z.unknown()),
}).strict();
const userOffboardingShape = {
  tenantId: z.string().min(2).max(64).optional(), userId: z.string().min(1).max(128),
  handoffTargetUserId: z.string().min(1).max(128), reasonCode: z.string().min(3).max(120),
};
export const userOffboardingPreviewSchema = z.object(userOffboardingShape).strict();
export const userOffboardingJobSchema = z.object({
  ...userOffboardingShape, idempotencyKey: z.string().min(8).max(200),
  previewId: z.string().regex(/^opv1\.[a-f0-9]{64}$/), baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export const createCandidateSchema = z.object({ definition: z.record(z.string(), z.unknown()) }).strict();
export const expectedRevisionSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const reviewSchema = z.object({
  expectedRevision: z.number().int().positive(), verdict: z.enum(['approved', 'rejected']),
  reason: z.string().min(1).max(1000),
}).strict();
export const publishCandidateSchema = z.object({
  expectedCandidateRevision: z.number().int().positive(), expectedSkillRevision: z.number().int().positive(),
}).strict();
