import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Router } from 'express';
import { z } from 'zod';

import type { PgAssignmentStore, ResourceAssignmentInput, ResourceAssignmentSet } from '../data/assignments/index.js';
import type { PgEntitlementStore } from '../data/entitlements/index.js';
import { governanceDigest } from '../data/governance-audit/index.js';

const assignmentSchema = z.object({
  assigneeType: z.enum(['everyone', 'user', 'directory_group', 'agent']),
  assigneeId: z.string().min(1).max(200).optional(),
  effect: z.enum(['allow', 'deny']),
  origin: z.enum(['direct', 'policy_default']).optional(),
}).strict();
const memoryMutationShape = {
  resourceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{1,119}$/),
  name: z.string().trim().min(1).max(120),
  status: z.enum(['enabled', 'disabled']),
  assignments: z.array(assignmentSchema).max(5000),
  expectedVersion: z.number().int().nonnegative(),
  reason: z.string().trim().min(3).max(500),
};
const previewSchema = z.object(memoryMutationShape).strict();
const commitSchema = z.object({
  ...memoryMutationShape,
  previewId: z.string().regex(/^mrpv1\.[a-f0-9]{64}$/),
  baselineDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();

type Persona = 'platform_admin' | 'org_admin' | 'member';
type AssignmentInput = z.infer<typeof assignmentSchema>;
type ValidationError = { status: number; body: { error: string; code: string } };

function signature(secret: string, input: Record<string, unknown>): string {
  return createHmac('sha256', secret).update(governanceDigest(input)).digest('hex');
}

function matches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function baseline(tenantId: string, resourceId: string, set: ResourceAssignmentSet | null): Record<string, unknown> {
  if (!set) return { tenantId, resourceType: 'org_memory', resourceId, version: 0 };
  return {
    tenantId, resourceType: 'org_memory', resourceId, version: set.version,
    name: set.resourceName, status: set.status,
    assignments: set.assignments.map(item => ({
      assigneeType: item.assigneeType,
      ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
      effect: item.effect,
      origin: item.origin,
    })),
  };
}

function simpleScope(set: ResourceAssignmentSet): {
  mode: 'none' | 'all' | 'selected' | 'advanced'; userIds: string[]; groupIds: string[];
} {
  const assignments = set.assignments;
  if (assignments.length === 0) return { mode: 'none', userIds: [], groupIds: [] };
  if (assignments.length === 1 && assignments[0]?.assigneeType === 'everyone' && assignments[0].effect === 'allow') {
    return { mode: 'all', userIds: [], groupIds: [] };
  }
  if (assignments.every(item => (item.assigneeType === 'user' || item.assigneeType === 'directory_group')
    && item.effect === 'allow' && item.assigneeId)) {
    return { mode: 'selected',
      userIds: [...new Set(assignments.filter(item => item.assigneeType === 'user').map(item => item.assigneeId!))].sort(),
      groupIds: [...new Set(assignments.filter(item => item.assigneeType === 'directory_group').map(item => item.assigneeId!))].sort() };
  }
  return { mode: 'advanced', userIds: [], groupIds: [] };
}

export function knowledgeSuites(sets: ResourceAssignmentSet[], policyEnabled: boolean) {
  const taskboardManifest = ['taskboard-projects', 'taskboard-tasks', 'taskboard-events'] as const;
  const taskboardIds = new Set<string>(taskboardManifest);
  const taskboardSets = sets.filter(set => set.resourceId.startsWith('taskboard-'));
  const groups: Array<{ suiteId: string; name: string; description: string; sets: ResourceAssignmentSet[];
    expectedResourceIds?: string[]; missingResourceIds?: string[]; unknownResourceIds?: string[] }> = [];
  if (taskboardSets.length) {
    const present = new Set(taskboardSets.map(set => set.resourceId));
    groups.push({ suiteId: 'taskboard', name: 'Taskboard 项目与任务',
      description: '项目、任务和变更历史作为一个授权套件原子提交。', sets: taskboardSets,
      expectedResourceIds: [...taskboardManifest],
      missingResourceIds: taskboardManifest.filter(resourceId => !present.has(resourceId)),
      unknownResourceIds: taskboardSets.filter(set => !taskboardIds.has(set.resourceId)).map(set => set.resourceId),
    });
  }
  for (const set of sets.filter(item => !item.resourceId.startsWith('taskboard-'))) {
    groups.push({ suiteId: `resource:${set.resourceId}`, name: set.resourceName ?? set.resourceId,
      description: '独立组织知识资源；复杂规则可在高级配置中管理。', sets: [set] });
  }
  return groups.map(group => {
    const scopes = group.sets.map(simpleScope);
    const first = scopes[0];
    const same = scopes.every(scope => scope.mode === first?.mode
      && scope.userIds.join('\u0000') === first.userIds.join('\u0000')
      && scope.groupIds.join('\u0000') === first.groupIds.join('\u0000'));
    const mode = same ? first?.mode ?? 'none' : 'mixed';
    const missingResourceIds = group.missingResourceIds ?? [];
    const unknownResourceIds = group.unknownResourceIds ?? [];
    return { suiteId: group.suiteId, name: group.name, description: group.description,
      policyEnabled, resourceIds: group.sets.map(set => set.resourceId),
      expectedResourceIds: group.expectedResourceIds ?? group.sets.map(set => set.resourceId),
      missingResourceIds, unknownResourceIds,
      completeness: missingResourceIds.length ? 'incomplete' : unknownResourceIds.length ? 'attention' : 'complete',
      resources: group.sets.map(set => ({ resourceId: set.resourceId, name: set.resourceName ?? set.resourceId,
        version: set.version, status: set.status ?? 'enabled' })),
      configuration: { mode, userIds: same ? first?.userIds ?? [] : [],
        groupIds: same ? first?.groupIds ?? [] : [] },
    };
  });
}

function publicResource(set: ResourceAssignmentSet, policyEnabled: boolean, includeScope: boolean) {
  return {
    resourceId: set.resourceId,
    name: set.resourceName ?? set.resourceId,
    status: set.status ?? 'enabled',
    policyEnabled,
    ...(includeScope ? { scope: set.assignments.map(item => ({
      assigneeType: item.assigneeType,
      ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
      effect: item.effect,
      origin: item.origin,
    })) } : { effectiveAssignment: 'assigned' as const }),
    source: set.source,
    version: set.version,
    updatedAt: set.updatedAt,
  };
}

export function registerGovernanceMemoryRoutes(options: {
  router: Router;
  assignments: PgAssignmentStore;
  entitlements: PgEntitlementStore;
  secret: string;
  previewTtlMs: number;
  now: () => Date;
  personaFor: (req: Request) => Persona | undefined;
  tenantFor: (req: Request, requested?: string) => string | null;
  validateSubjects: (tenantId: string, assignments: AssignmentInput[]) => Promise<ValidationError | null>;
  assignmentSnapshot: (tenantId: string, assignments: AssignmentInput[]) => Promise<Record<string, unknown>>;
}): void {
  const { router } = options;

  router.get('/organization-resources/memory-knowledge', async (req, res) => {
    const persona = options.personaFor(req);
    if (!persona) return res.status(403).json({ error: 'Membership required' });
    const tenantId = options.tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const [knowledgeSets, memorySets, policies] = await Promise.all([
      options.assignments.listResourceSets(tenantId, 'org_knowledge'),
      options.assignments.listResourceSets(tenantId, 'org_memory'),
      options.entitlements.getPolicies(tenantId),
    ]);
    const policy = new Map(policies.map(item => [item.policyKey, item]));
    const knowledgeEnabled = policy.get('knowledge.org.enabled')?.value === true;
    const memoryEnabled = policy.get('memory.consolidation.enabled')?.value === true;
    const includeScope = persona !== 'member';
    let knowledge = knowledgeSets;
    let memory = memorySets;
    if (!includeScope) {
      const [knowledgeIds, memoryIds] = await Promise.all([
        options.assignments.listEffectiveResourceIds(tenantId, req.user!.sub, 'org_knowledge'),
        options.assignments.listEffectiveResourceIds(tenantId, req.user!.sub, 'org_memory'),
      ]);
      const effectiveKnowledge = new Set(knowledgeIds.map(item => item.resourceId));
      const effectiveMemory = new Set(memoryIds.map(item => item.resourceId));
      knowledge = knowledge.filter(item => effectiveKnowledge.has(item.resourceId));
      memory = memory.filter(item => item.status === 'enabled' && effectiveMemory.has(item.resourceId));
    }
    return res.json({
      tenantId,
      authority: 'governance_assignment_sets',
      accessMode: persona === 'org_admin' || persona === 'platform_admin' ? 'manage' : 'effective_only',
      ...(req.query.includeSuites === '1' ? { suites: knowledgeSuites(knowledge, knowledgeEnabled) } : {}),
      knowledge: knowledge.map(set => ({
        resourceId: set.resourceId,
        name: set.resourceName ?? set.resourceId,
        status: knowledgeEnabled ? 'enabled' : 'disabled',
        policyEnabled: knowledgeEnabled,
        ...(includeScope ? { scope: set.assignments.map(item => ({
          assigneeType: item.assigneeType,
          ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}),
          effect: item.effect,
          origin: item.origin,
        })) } : { effectiveAssignment: 'assigned' as const }),
        source: set.source, version: set.version, updatedAt: set.updatedAt,
      })),
      memory: memory.map(set => publicResource(set, memoryEnabled, includeScope)),
      effective: { organizationKnowledge: knowledgeEnabled, organizationMemory: memoryEnabled },
    });
  });

  router.post('/organization-resources/memory/preview', async (req, res) => {
    if (!['platform_admin', 'org_admin'].includes(options.personaFor(req) ?? '')) {
      return res.status(403).json({ error: 'Organization admin required' });
    }
    const parsed = previewSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid request' });
    const tenantId = options.tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const current = await options.assignments.getAssignmentSet(tenantId, 'org_memory', parsed.data.resourceId);
    if ((current?.version ?? 0) !== parsed.data.expectedVersion) {
      return res.status(409).json({ error: 'Memory baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    let directorySnapshot: Record<string, unknown>;
    try {
      directorySnapshot = await options.assignmentSnapshot(tenantId, parsed.data.assignments);
    } catch {
      return res.status(503).json({ error: 'Directory authority unavailable or stale', code: 'DIRECTORY_GROUP_AUTHORITY_STALE' });
    }
    const subjectError = await options.validateSubjects(tenantId, parsed.data.assignments);
    if (subjectError) return res.status(subjectError.status).json(subjectError.body);
    const baselineDigest = governanceDigest({ resource: baseline(tenantId, parsed.data.resourceId, current), directorySnapshot });
    const expiresAt = new Date(options.now().getTime() + options.previewTtlMs).toISOString();
    const signed = {
      version: 1, kind: 'org_memory', actorUserId: req.user!.sub, actorTenantId: req.user!.tenantId,
      actorPersona: options.personaFor(req), tenantId,
      baselineDigest, expiresAt, changeDigest: governanceDigest(parsed.data),
    };
    return res.json({
      previewId: `mrpv1.${signature(options.secret, signed)}`,
      baselineDigest, expiresAt,
      impact: {
        operation: current ? 'update' : 'create', resourceId: parsed.data.resourceId,
        currentVersion: current?.version ?? 0, nextVersion: (current?.version ?? 0) + 1,
        fromStatus: current?.status ?? null, toStatus: parsed.data.status,
        assignmentCount: parsed.data.assignments.length, reversible: true,
      },
      changeId: res.locals.governanceChangeId,
    });
  });

  router.put('/organization-resources/memory/:resourceId', async (req, res) => {
    if (!['platform_admin', 'org_admin'].includes(options.personaFor(req) ?? '')) {
      return res.status(403).json({ error: 'Organization admin required' });
    }
    const parsed = commitSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.resourceId !== req.params.resourceId) return res.status(400).json({ error: 'Invalid request' });
    const tenantId = options.tenantFor(req, typeof req.query.tenantId === 'string' ? req.query.tenantId : undefined);
    if (!tenantId) return res.status(403).json({ error: 'Tenant scope denied' });
    const { previewId, baselineDigest, expiresAt, ...mutation } = parsed.data;
    if (Date.parse(expiresAt) <= options.now().getTime()) {
      return res.status(409).json({ error: 'Memory preview expired', code: 'GOVERNANCE_PREVIEW_EXPIRED' });
    }
    const expectedPreviewId = `mrpv1.${signature(options.secret, {
      version: 1, kind: 'org_memory', actorUserId: req.user!.sub, actorTenantId: req.user!.tenantId,
      actorPersona: options.personaFor(req), tenantId,
      baselineDigest, expiresAt, changeDigest: governanceDigest(mutation),
    })}`;
    if (!matches(previewId, expectedPreviewId)) {
      return res.status(409).json({ error: 'Memory preview invalid', code: 'GOVERNANCE_PREVIEW_INVALID' });
    }
    const current = await options.assignments.getAssignmentSet(tenantId, 'org_memory', mutation.resourceId);
    let directorySnapshot: Record<string, unknown>;
    try {
      directorySnapshot = await options.assignmentSnapshot(tenantId, mutation.assignments);
    } catch {
      return res.status(503).json({ error: 'Directory authority unavailable or stale', code: 'DIRECTORY_GROUP_AUTHORITY_STALE' });
    }
    const currentDigest = governanceDigest({ resource: baseline(tenantId, mutation.resourceId, current), directorySnapshot });
    if ((current?.version ?? 0) !== mutation.expectedVersion || currentDigest !== baselineDigest) {
      return res.status(409).json({ error: 'Memory baseline changed', code: 'GOVERNANCE_PREVIEW_BASELINE_CONFLICT' });
    }
    const subjectError = await options.validateSubjects(tenantId, mutation.assignments);
    if (subjectError) return res.status(subjectError.status).json(subjectError.body);
    try {
      const set = await options.assignments.replaceAssignments(
        tenantId, 'org_memory', mutation.resourceId,
        mutation.assignments as ResourceAssignmentInput[], mutation.expectedVersion, req.user!.sub,
        { resourceName: mutation.name, status: mutation.status },
      );
      return res.json({
        resourceId: set.resourceId, name: set.resourceName ?? set.resourceId,
        status: set.status ?? 'enabled', source: set.source, version: set.version, updatedAt: set.updatedAt,
        scope: set.assignments.map(item => ({ assigneeType: item.assigneeType, ...(item.assigneeId ? { assigneeId: item.assigneeId } : {}), effect: item.effect })),
        changeId: res.locals.governanceChangeId, effectiveAt: set.updatedAt,
      });
    } catch (error) {
      return res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
