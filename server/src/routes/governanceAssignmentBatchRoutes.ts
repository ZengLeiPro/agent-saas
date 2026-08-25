import type { Request, Router } from 'express';

import { AssignmentInvariantError, type PgAssignmentStore } from '../data/assignments/index.js';
import type { AssignmentResourceType } from '../data/assignments/types.js';
import { governanceDigest } from '../data/governance-audit/index.js';
import type { PgGovernanceProjectionOutboxStore, GovernanceProjectionReconciler } from '../data/governanceProjection/index.js';
import type { PgMembershipStore } from '../data/memberships/index.js';
import {
  assignmentBaseline,
  assignmentBatchPatchSchema,
  assignmentBatchPreviewSchema,
  previewMatches,
  previewSignature,
  type AssignmentBatchMutation,
  type GovernancePersona,
} from './governanceAccessValidation.js';

type ValidationError = { status: number; body: { error: string; code: string } };
type Profile = { displayName: string };
type AgentProfile = { name: string };

export function registerGovernanceAssignmentBatchRoutes(options: {
  router: Router;
  assignments: PgAssignmentStore;
  memberships: Pick<PgMembershipStore, 'listMemberships'>;
  secret: string;
  previewTtlMs: number;
  now: () => Date;
  personaFor: (req: Request) => GovernancePersona | undefined;
  tenantFor: (req: Request, requested?: string) => string | null;
  validateSubjects: (tenantId: string, assignments: AssignmentBatchMutation['changes'][number]['assignments']) => Promise<ValidationError | null>;
  validateResource: (tenantId: string, resourceType: AssignmentResourceType, resourceId: string) => Promise<ValidationError | null>;
  assignmentSnapshot: (tenantId: string, assignments: AssignmentBatchMutation['changes'][number]['assignments']) => Promise<Record<string, unknown>>;
  getMemberProfile?: (tenantId: string, userId: string) => Profile | null;
  getAgentProfile?: (tenantId: string, agentId: string) => AgentProfile | null;
  projectionOutbox?: PgGovernanceProjectionOutboxStore;
  projectionReconciler?: GovernanceProjectionReconciler;
}): void {
  const { router } = options;

  router.post('/assignments/batch/preview', async (req, res) => {
    if (options.personaFor(req) !== 'org_admin') return res.status(403).json({ error: 'Organization admin required' });
    const parsed = assignmentBatchPreviewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = options.tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const keys = parsed.data.changes.map(change => `${change.resourceType}\u0000${change.resourceId}`);
    if (new Set(keys).size !== keys.length) return res.status(400).json({ error: 'Duplicate assignment resource' });
    for (const change of parsed.data.changes) {
      const resourceError = await options.validateResource(tenantId, change.resourceType, change.resourceId);
      if (resourceError) return res.status(resourceError.status).json(resourceError.body);
      const subjectError = await options.validateSubjects(tenantId, change.assignments);
      if (subjectError) return res.status(subjectError.status).json(subjectError.body);
    }
    let prepared: Awaited<ReturnType<typeof assignmentBatchBaseline>>;
    try { prepared = await assignmentBatchBaseline(options, tenantId, parsed.data); }
    catch { return res.status(503).json({ error: 'Directory authority unavailable or stale', code: 'DIRECTORY_GROUP_AUTHORITY_STALE' }); }
    const versionConflict = parsed.data.changes.find((change, index) =>
      (prepared.currentSets[index]?.version ?? 0) !== change.expectedVersion);
    if (versionConflict) {
      return res.status(409).json({ error: 'Assignment baseline version changed',
        code: 'ASSIGNMENT_PREVIEW_BASELINE_CONFLICT', resourceId: versionConflict.resourceId });
    }
    const expiresAt = new Date(options.now().getTime() + options.previewTtlMs).toISOString();
    const signatureInput = { version: 1, actorUserId: req.user!.sub, actorTenantId: req.user!.tenantId,
      tenantId, baselineDigest: prepared.baselineDigest, expiresAt, changeDigest: governanceDigest(parsed.data) };
    const memberships = await options.memberships.listMemberships(tenantId);
    const activeUserIds = memberships.filter(member => member.status === 'active').map(member => member.userId);
    const memberNames = new Map(memberships.map(item => [item.userId,
      options.getMemberProfile?.(tenantId, item.userId)?.displayName ?? item.userId]));
    const changes = parsed.data.changes.map((change, index) => {
      const audience = audienceSnapshot(prepared.directorySnapshots[index], activeUserIds);
      const subject = (item: { assigneeType: string; assigneeId?: string; effect: string }) => ({
        assigneeType: item.assigneeType, ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}), effect: item.effect,
        label: item.assigneeType === 'everyone' ? `所有有效成员（${activeUserIds.length} 人）`
          : item.assigneeType === 'user' && item.assigneeId ? memberNames.get(item.assigneeId) ?? item.assigneeId
            : item.assigneeType === 'directory_group' && item.assigneeId
              ? audience.groupNames.get(item.assigneeId) ?? item.assigneeId
              : item.assigneeType === 'agent' && item.assigneeId
                ? options.getAgentProfile?.(tenantId, item.assigneeId)?.name ?? item.assigneeId
                : item.assigneeId ?? item.assigneeType,
      });
      return assignmentDiff(change, prepared.currentSets[index]?.assignments ?? [], subject, audience);
    });
    const effectiveUsers = new Set(changes.flatMap(change => change.afterUserIds));
    const addedUsers = new Set(changes.flatMap(change => change.addedUserIds));
    const removedUsers = new Set(changes.flatMap(change => change.removedUserIds));
    return res.json({
      previewId: `abpv1.${previewSignature(options.secret, signatureInput)}`,
      baselineDigest: prepared.baselineDigest, expiresAt,
      changes: changes.map(({ beforeUserIds: _before, afterUserIds: _after,
        addedUserIds: _added, removedUserIds: _removed, ...change }) => change),
      impact: { resourceCount: changes.length, atomic: true,
        directSubjectCount: new Set(parsed.data.changes.flatMap(change => change.assignments
          .map(item => `${item.assigneeType}:${item.assigneeId ?? ''}`))).size,
        effectiveUserCount: effectiveUsers.size, addedUserCount: addedUsers.size, removedUserCount: removedUsers.size,
        agentRuleCount: parsed.data.changes.flatMap(change => change.assignments)
          .filter(item => item.assigneeType === 'agent').length,
        requiresNewSession: true },
      changeId: res.locals.governanceChangeId,
    });
  });

  router.put('/assignments/batch', async (req, res) => {
    if (options.personaFor(req) !== 'org_admin') return res.status(403).json({ error: 'Organization admin required' });
    const parsed = assignmentBatchPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid body' });
    const tenantId = options.tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const { previewId, baselineDigest, expiresAt, ...mutation } = parsed.data;
    if (Date.parse(expiresAt) <= options.now().getTime()) {
      return res.status(409).json({ error: 'Assignment preview expired', code: 'ASSIGNMENT_PREVIEW_EXPIRED' });
    }
    const expectedPreviewId = `abpv1.${previewSignature(options.secret, {
      version: 1, actorUserId: req.user!.sub, actorTenantId: req.user!.tenantId,
      tenantId, baselineDigest, expiresAt, changeDigest: governanceDigest(mutation),
    })}`;
    if (!previewMatches(previewId, expectedPreviewId)) {
      return res.status(409).json({ error: 'Assignment preview invalid', code: 'ASSIGNMENT_PREVIEW_INVALID' });
    }
    let prepared: Awaited<ReturnType<typeof assignmentBatchBaseline>>;
    try { prepared = await assignmentBatchBaseline(options, tenantId, mutation); }
    catch { return res.status(503).json({ error: 'Directory authority unavailable or stale', code: 'DIRECTORY_GROUP_AUTHORITY_STALE' }); }
    if (prepared.baselineDigest !== baselineDigest || mutation.changes.some((change, index) =>
      (prepared.currentSets[index]?.version ?? 0) !== change.expectedVersion)) {
      return res.status(409).json({ error: 'Assignment preview baseline changed', code: 'ASSIGNMENT_PREVIEW_BASELINE_CONFLICT' });
    }
    for (const change of mutation.changes) {
      const resourceError = await options.validateResource(tenantId, change.resourceType, change.resourceId);
      if (resourceError) return res.status(resourceError.status).json(resourceError.body);
      const subjectError = await options.validateSubjects(tenantId, change.assignments);
      if (subjectError) return res.status(subjectError.status).json(subjectError.body);
    }
    let sets: Awaited<ReturnType<PgAssignmentStore['replaceAssignmentSetsAtomically']>>;
    const projectionIds: string[] = [];
    try {
      sets = await options.assignments.replaceAssignmentSetsAtomically(
        tenantId, mutation.changes, req.user!.sub,
        options.projectionOutbox ? async (client, committedSets) => {
          for (const set of committedSets) {
            const projection = await options.projectionOutbox!.enqueueWithClient(client, {
              tenantId, projector: 'assignment',
              idempotencyKey: `${set.resourceType}:${set.resourceId}:${set.version}`,
              payload: { tenantId, resourceType: set.resourceType, resourceId: set.resourceId, version: set.version },
            });
            projectionIds.push(projection.outboxId);
          }
        } : undefined,
      );
    } catch (error) {
      return res.status(error instanceof AssignmentInvariantError ? 409 : 500).json({
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof AssignmentInvariantError ? error.code : 'ASSIGNMENT_BATCH_WRITE_FAILED',
        changed: false,
      });
    }
    void options.projectionReconciler?.reconcileOne();
    return res.json({ sets, changed: true, effectiveAt: sets[0]?.updatedAt ?? options.now().toISOString(),
      projectionStatus: options.projectionOutbox ? 'pending' : 'not_configured', projectionIds,
      requiresNewSession: true });
  });
}

async function assignmentBatchBaseline(options: Parameters<typeof registerGovernanceAssignmentBatchRoutes>[0],
  tenantId: string, mutation: AssignmentBatchMutation) {
  const currentSets = await Promise.all(mutation.changes.map(change => options.assignments.getAssignmentSet(
    tenantId, change.resourceType, change.resourceId,
  )));
  const directorySnapshots: Record<string, unknown>[] = [];
  for (const [index, change] of mutation.changes.entries()) {
    const currentAssignments = (currentSets[index]?.assignments ?? []).map(item => ({
      assigneeType: item.assigneeType, ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
      effect: item.effect,
    }));
    directorySnapshots.push(await options.assignmentSnapshot(tenantId, [...currentAssignments, ...change.assignments]));
  }
  const baseline = mutation.changes.map((change, index) => ({
    assignment: assignmentBaseline(tenantId, change.resourceType, change.resourceId, currentSets[index] ?? null),
    directorySnapshot: directorySnapshots[index],
  }));
  return { currentSets, directorySnapshots, baselineDigest: governanceDigest({ assignments: baseline }) };
}

type AudienceSnapshot = {
  activeUserIds: string[];
  groupMembers: Map<string, Set<string>>;
  groupNames: Map<string, string>;
};

function audienceSnapshot(value: Record<string, unknown> | undefined, fallbackUsers: string[]): AudienceSnapshot {
  const activeMemberships = Array.isArray(value?.activeMemberships) ? value.activeMemberships : [];
  const activeUserIds = activeMemberships.flatMap(item => item && typeof item === 'object'
    && typeof (item as { userId?: unknown }).userId === 'string' ? [(item as { userId: string }).userId] : []);
  const groups = Array.isArray(value?.groups) ? value.groups : [];
  const groupMembers = new Map<string, Set<string>>();
  const groupNames = new Map<string, string>();
  for (const item of groups) {
    if (!item || typeof item !== 'object') continue;
    const group = item as { groupId?: unknown; displayName?: unknown; memberUserIds?: unknown };
    if (typeof group.groupId !== 'string') continue;
    groupMembers.set(group.groupId, new Set(Array.isArray(group.memberUserIds)
      ? group.memberUserIds.filter((id): id is string => typeof id === 'string') : []));
    if (typeof group.displayName === 'string' && group.displayName.trim()) groupNames.set(group.groupId, group.displayName);
  }
  return { activeUserIds: activeUserIds.length ? activeUserIds : fallbackUsers, groupMembers, groupNames };
}

function effectiveUsers(assignments: Array<{ assigneeType: string; assigneeId?: string; effect: string }>,
  audience: AudienceSnapshot): string[] {
  return audience.activeUserIds.filter(userId => {
    const matches = assignments.filter(item => item.assigneeType === 'everyone'
      || (item.assigneeType === 'user' && item.assigneeId === userId)
      || (item.assigneeType === 'directory_group' && item.assigneeId
        && audience.groupMembers.get(item.assigneeId)?.has(userId)));
    return !matches.some(item => item.effect === 'deny') && matches.some(item => item.effect === 'allow');
  });
}

function assignmentDiff(change: AssignmentBatchMutation['changes'][number], beforeValues: Array<{
  assigneeType: string; assigneeId?: string; effect: string;
}>, subject: (item: { assigneeType: string; assigneeId?: string; effect: string }) => {
  assigneeType: string; assigneeId?: string; effect: string; label: string;
}, audience: AudienceSnapshot) {
  const before = beforeValues.map(subject);
  const after = change.assignments.map(subject);
  const key = (item: ReturnType<typeof subject>) => `${item.assigneeType}:${item.assigneeId ?? ''}:${item.effect}`;
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  const beforeUserIds = effectiveUsers(beforeValues, audience);
  const afterUserIds = effectiveUsers(change.assignments, audience);
  const beforeUsers = new Set(beforeUserIds);
  const afterUsers = new Set(afterUserIds);
  const addedUserIds = afterUserIds.filter(userId => !beforeUsers.has(userId));
  const removedUserIds = beforeUserIds.filter(userId => !afterUsers.has(userId));
  return { resourceType: change.resourceType, resourceId: change.resourceId, expectedVersion: change.expectedVersion,
    before, after, addedCount: after.filter(item => !beforeKeys.has(key(item))).length,
    removedCount: before.filter(item => !afterKeys.has(key(item))).length,
    beforeUserCount: beforeUserIds.length, afterUserCount: afterUserIds.length,
    addedUserCount: addedUserIds.length, removedUserCount: removedUserIds.length,
    beforeUserIds, afterUserIds, addedUserIds, removedUserIds };
}
