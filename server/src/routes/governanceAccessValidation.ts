import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PgAssignmentStore } from '../data/assignments/index.js';
import type { AssignmentResourceType } from '../data/assignments/types.js';
import { governanceDigest } from '../data/governance-audit/index.js';
import { MembershipInvariantError, type TenantMembership } from '../data/memberships/index.js';

const membershipMutationShape = {
  expectedVersion: z.number().int().positive(),
  persona: z.enum(['member', 'org_admin']).optional(),
  isOwner: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional(),
  reason: z.string().min(3).max(500).optional(),
};
export const membershipPreviewSchema = z.object(membershipMutationShape).strict();
export const membershipPatchSchema = z.object({
  ...membershipMutationShape,
  previewId: z.string().regex(/^mpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

const MEMBER_USERNAME_PATTERN = /^[a-zA-Z0-9\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff][a-zA-Z0-9_\-\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]*$/;
const memberPermissionsSchema = z.object({
  maxTurns: z.number().int().positive().optional(),
  rateLimit: z.object({
    maxRequests: z.number().int().positive().optional(),
    windowMs: z.number().int().positive().optional(),
  }).optional(),
}).strict();
export const membershipCreateSchema = z.object({
  username: z.string().min(1).max(50).regex(MEMBER_USERNAME_PATTERN),
  password: z.string().min(6),
  role: z.enum(['admin', 'user']).default('user'),
  realName: z.string().max(100).optional(),
  position: z.string().max(50).optional(),
  dingtalkStaffId: z.string().max(200).optional(),
  debugMode: z.boolean().optional().default(false),
  permissions: memberPermissionsSchema.optional(),
}).strict();

export type MembershipCreateInput = z.infer<typeof membershipCreateSchema>;
export const platformAdminPatchSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: z.enum(['active', 'disabled']),
}).strict();
export const assignmentResourceTypeSchema = z.enum([
  'org_agent', 'skill', 'credential', 'environment_template',
  'org_knowledge', 'org_memory', 'connector', 'dws_delegation',
]);
const assignmentMutationShape = {
  expectedVersion: z.number().int().nonnegative(),
  assignments: z.array(z.object({
    assigneeType: z.enum(['everyone', 'user', 'directory_group', 'agent']),
    assigneeId: z.string().min(1).max(200).optional(),
    effect: z.enum(['allow', 'deny']),
    origin: z.enum(['direct', 'policy_default']).optional(),
  }).strict()).max(5000),
};
export const assignmentPreviewSchema = z.object(assignmentMutationShape).strict();
export const assignmentPatchSchema = z.object({
  ...assignmentMutationShape,
  previewId: z.string().regex(/^apv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export const contentGrantSchema = z.object({
  tenantId: z.string().min(2).max(64).optional(),
  subjectUserId: z.string().min(1).max(128),
  targetType: z.enum(['session', 'guardrail_collection']),
  targetId: z.string().min(1).max(200),
  scopes: z.array(z.enum(['qa_read', 'session_export', 'guardrail_read'])).min(1).max(3),
  purpose: z.string().min(3).max(500),
  reasonCode: z.string().min(3).max(120),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
export const contentGrantRevokeSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export const auditQuerySchema = z.object({
  tenantId: z.string().min(2).max(64).optional(),
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
export const preferenceSchema = z.object({
  resourceType: z.string().min(1).max(80),
  resourceId: z.string().min(1).max(200),
  enabled: z.boolean(),
  expectedVersion: z.number().int().nonnegative(),
}).strict();

export type MembershipMutation = z.infer<typeof membershipPreviewSchema>;
export type AssignmentMutation = z.infer<typeof assignmentPreviewSchema>;
export type GovernancePersona = 'platform_admin' | 'org_admin' | 'member';
export type MembershipActionId = 'promote_admin' | 'demote_member' | 'grant_owner' | 'revoke_owner' | 'disable' | 'restore' | 'recover_owner';
export interface MembershipAllowedAction {
  id: MembershipActionId;
  label: string;
  change: Pick<MembershipMutation, 'persona' | 'isOwner' | 'status'>;
  requiresReason: boolean;
}

export const ASSIGNMENT_RESOURCE_TYPES: readonly AssignmentResourceType[] = [
  'org_agent', 'skill', 'credential', 'environment_template',
  'org_knowledge', 'org_memory', 'connector', 'dws_delegation',
];

export function membershipBaseline(membership: TenantMembership): Record<string, unknown> {
  return {
    tenantId: membership.tenantId,
    userId: membership.userId,
    persona: membership.persona,
    isOwner: membership.isOwner,
    status: membership.status,
    version: membership.version,
  };
}

export function membershipChange(mutation: MembershipMutation): Record<string, unknown> {
  return {
    expectedVersion: mutation.expectedVersion,
    ...(mutation.persona !== undefined ? { persona: mutation.persona } : {}),
    ...(mutation.isOwner !== undefined ? { isOwner: mutation.isOwner } : {}),
    ...(mutation.status !== undefined ? { status: mutation.status } : {}),
    ...(mutation.reason !== undefined ? { reason: mutation.reason } : {}),
  };
}

export function assignmentBaseline(
  tenantId: string,
  resourceType: string,
  resourceId: string,
  assignmentSet: Awaited<ReturnType<PgAssignmentStore['getAssignmentSet']>>,
): Record<string, unknown> {
  return assignmentSet ? {
    tenantId,
    resourceType,
    resourceId,
    version: assignmentSet.version,
    assignments: assignmentSet.assignments.map(item => ({
      assigneeType: item.assigneeType,
      ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
      effect: item.effect,
      origin: item.origin,
    })),
  } : { tenantId, resourceType, resourceId, version: 0, assignments: [] };
}

export function previewSignature(secret: string, input: Record<string, unknown>): string {
  return createHmac('sha256', secret).update(governanceDigest(input)).digest('hex');
}

export function previewMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function membershipErrorStatus(error: unknown): number {
  if (!(error instanceof MembershipInvariantError)) return 409;
  return error.code === 'MEMBERSHIP_CHANGE_FORBIDDEN'
    || error.code === 'PLATFORM_RECOVERY_SCOPE_REQUIRED' ? 403 : 409;
}
