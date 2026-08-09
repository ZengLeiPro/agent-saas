import { describe, expect, it } from 'vitest';
import { RunPreflightService } from '../runtime/runPreflight.js';
import { AccessEvaluator } from '../governance/access/evaluator.js';
import {
  AssignmentPolicy,
  EntitlementPolicy,
  LongTermGrantPolicy,
  PersonaPolicy,
  PlatformInvariantPolicy,
  RuntimeApprovalPolicy,
  TenantPolicy,
} from '../governance/access/policies/index.js';
import { ReadinessEvaluator } from '../governance/readiness/evaluator.js';
import { SubjectResolver } from '../governance/subject/resolver.js';
import {
  assertRunSnapshotHasNoSensitivePayload,
  PgRunResolutionSnapshotStore,
} from '../runtime/runResolutionSnapshotStore.js';
import type { RuntimeSessionRecord } from '../runtime/sessionCatalog.js';
import type { OrgAgentRecord } from '../data/orgAgents/types.js';
import type { TenantMembership, PlatformAdmin } from '../data/memberships/types.js';
import type { EntitlementResourceScope, TenantEntitlementSet, TenantPolicy as TenantPolicyRecord } from '../data/entitlements/types.js';
import type { ResourceAssignmentSet } from '../data/assignments/types.js';
import type { UserRecord } from '../data/users/index.js';
import type { TenantRecord } from '../data/tenants/types.js';

const NOW = '2026-08-08T00:00:00.000Z';

function userRecord(tenantId = 'tenant-1'): UserRecord {
  return {
    id: 'user-1',
    username: 'alice',
    passwordHash: 'x',
    role: 'user',
    tenantId,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as UserRecord;
}

function membership(overrides: Partial<TenantMembership> = {}): TenantMembership {
  return {
    tenantId: 'tenant-1',
    userId: 'user-1',
    persona: 'member',
    isOwner: false,
    status: 'active',
    source: 'governance',
    version: 2,
    createdAt: NOW,
    createdBy: 'test',
    updatedAt: NOW,
    updatedBy: 'test',
    ...overrides,
  };
}

function entitlementSet(): TenantEntitlementSet {
  return {
    tenantId: 'tenant-1',
    source: 'plan_default',
    status: 'active',
    limits: {},
    version: 4,
    createdAt: NOW,
    createdBy: 'test',
    updatedAt: NOW,
    updatedBy: 'test',
    updateReason: 'test',
  };
}

function policyRecord(value: TenantPolicyRecord['value']): TenantPolicyRecord {
  return {
    tenantId: 'tenant-1',
    policyKey: 'agent.personal.enabled',
    value,
    source: 'governance',
    version: 6,
    createdAt: NOW,
    createdBy: 'test',
    updatedAt: NOW,
    updatedBy: 'test',
  };
}

function scopeRecord(): EntitlementResourceScope {
  return {
    tenantId: 'tenant-1',
    resourceType: 'tool',
    mode: 'all',
    resourceIds: [],
    source: 'governance',
    version: 4,
    createdAt: NOW,
    createdBy: 'test',
    updatedAt: NOW,
    updatedBy: 'test',
  };
}

function assignmentSetFor(agentId: string, assignments: Array<{ assigneeType: 'everyone' | 'user'; assigneeId?: string; effect: 'allow' | 'deny' }>): ResourceAssignmentSet {
  return {
    tenantId: 'tenant-1',
    resourceType: 'org_agent',
    resourceId: agentId,
    source: 'governance',
    version: 9,
    assignments: assignments.map((input, index) => ({
      assignmentId: `as-${index}`,
      tenantId: 'tenant-1',
      resourceType: 'org_agent' as const,
      resourceId: agentId,
      assigneeType: input.assigneeType,
      ...(input.assigneeId ? { assigneeId: input.assigneeId } : {}),
      effect: input.effect,
      origin: 'direct' as const,
      version: 1,
      createdAt: NOW,
      createdBy: 'test',
      updatedAt: NOW,
      updatedBy: 'test',
    })),
    createdAt: NOW,
    createdBy: 'test',
    updatedAt: NOW,
    updatedBy: 'test',
  };
}

function orgAgent(overrides: Partial<OrgAgentRecord> = {}): OrgAgentRecord {
  return {
    id: 'oa-1',
    tenantId: 'tenant-1',
    name: '销售专家',
    description: '',
    starterPrompts: [],
    instructions: '',
    allowedSkills: ['skill-1'],
    audience: { exposure: 'all', usernames: [] },
    guardrail: { enabled: false, scopeDescription: '', rejectionMessage: '', strictness: 'strict' },
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as OrgAgentRecord;
}

function session(overrides: Partial<RuntimeSessionRecord> = {}): RuntimeSessionRecord {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    username: 'alice',
    tenantId: 'tenant-1',
    channel: 'web',
    cwd: '/tmp',
    transcriptPath: '/tmp/t.jsonl',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface PreflightFixtureOverrides {
  membership?: TenantMembership | null;
  platformAdmin?: PlatformAdmin | null;
  entitlement?: TenantEntitlementSet | null;
  policies?: TenantPolicyRecord[];
  assignmentSets?: Map<string, ResourceAssignmentSet | null>;
  orgAgent?: OrgAgentRecord;
  tenantDisabled?: boolean;
  billing?: { ok: boolean; code?: string; reason?: string };
  modelAvailable?: boolean;
  enforcementMode?: 'shadow' | 'enforce';
}

function buildService(overrides: PreflightFixtureOverrides = {}) {
  const membershipValue = overrides.membership === undefined ? membership() : overrides.membership;
  const entitlementValue = overrides.entitlement === undefined ? entitlementSet() : overrides.entitlement;
  const policies = overrides.policies ?? [policyRecord(true)];
  const assignmentSets = overrides.assignmentSets ?? new Map([['oa-1', assignmentSetFor('oa-1', [{ assigneeType: 'everyone', effect: 'allow' }])]]);
  const agent = overrides.orgAgent === undefined ? orgAgent() : overrides.orgAgent;

  const userStore = { findById: (id: string) => (id === 'user-1' ? userRecord() : undefined) };
  const membershipStore = {
    getMembership: async () => membershipValue,
    getPlatformAdmin: async () => overrides.platformAdmin ?? null,
  };
  const entitlementStore = {
    getEntitlementSet: async () => entitlementValue,
    listResourceScopes: async () => [scopeRecord()],
    getPolicies: async () => policies,
  };
  const assignmentStore = {
    getAssignmentSet: async (_tenantId: string, _type: string, resourceId: string) =>
      assignmentSets.has(resourceId) ? assignmentSets.get(resourceId)! : null,
  };
  const sessionCatalog = { get: async () => session() };
  const orgAgentStore = { get: (id: string) => (agent && id === agent.id ? agent : undefined) };
  const tenantStore = {
    findById: (id: string) => (id === 'tenant-1'
      ? ({ id: 'tenant-1', name: 'T', disabled: overrides.tenantDisabled === true } as unknown as TenantRecord)
      : undefined),
  };

  const service = new RunPreflightService({
    enforcementMode: overrides.enforcementMode ?? 'shadow',
    subjectResolver: new SubjectResolver(userStore as never, membershipStore),
    accessEvaluator: new AccessEvaluator([
      new PlatformInvariantPolicy(),
      new EntitlementPolicy(entitlementStore),
      new PersonaPolicy(),
      new TenantPolicy(entitlementStore),
      new AssignmentPolicy(assignmentStore),
      new LongTermGrantPolicy(),
      new RuntimeApprovalPolicy(),
    ]),
    readinessEvaluator: new ReadinessEvaluator(),
    sessionCatalog,
    orgAgentStore,
    tenantStore,
    ...(overrides.billing ? { authorizeBilling: async () => overrides.billing! } : {}),
    ...(overrides.modelAvailable !== undefined ? { isModelAvailable: () => overrides.modelAvailable! } : {}),
  });
  return service;
}

const baseInput = {
  phase: 'enqueue' as const,
  runId: 'run-1',
  sessionId: 'session-1',
  userId: 'user-1',
  tenantId: 'tenant-1',
  orgAgentId: 'oa-1',
  modelRef: 'gpt-test',
};

describe('RunPreflightService shadow/enforce 行为', () => {
  it('enqueue allow：快照含 agent/skills/memory 引用且 proceed=true', async () => {
    const result = await buildService().preflight(baseInput);
    expect(result.proceed).toBe(true);
    expect(result.shadowWouldBlock).toBe(false);
    expect(result.accessDecision.verdict).toBe('allow');
    expect(result.readiness.ready).toBe(true);
    expect(result.snapshot.agent).toEqual({ type: 'org_agent', id: 'oa-1' });
    expect(result.snapshot.skills).toEqual([{ id: 'skill-1' }]);
    expect(result.snapshot.memoryScopes).toEqual([{ id: 'user:user-1' }]);
    expect(result.snapshot.model).toEqual({ id: 'gpt-test' });
    expect(result.snapshot.enforcementMode).toBe('shadow');
  });

  it('队列等待期间撤销 assignment：wake 复核 conditional，shadow 放行但打标 wouldBlock', async () => {
    const service = buildService({ assignmentSets: new Map([['oa-1', assignmentSetFor('oa-1', [])]]) });
    const result = await service.preflight({ ...baseInput, phase: 'wake' });
    expect(result.accessDecision.accessState).toBe('needs_assignment');
    expect(result.shadowWouldBlock).toBe(true);
    expect(result.proceed).toBe(true);
  });

  it('enforce 模式下 wake 复核失败时 fail closed，模型适配器不得被调用', async () => {
    const service = buildService({
      enforcementMode: 'enforce',
      assignmentSets: new Map([['oa-1', assignmentSetFor('oa-1', [])]]),
    });
    const result = await service.preflight({ ...baseInput, phase: 'wake' });
    expect(result.proceed).toBe(false);
    expect(result.accessDecision.verdict).toBe('conditional');
  });

  it('成员被禁用：wake 复核 SUBJECT_DISABLED 且 enforce 阻断', async () => {
    const service = buildService({
      enforcementMode: 'enforce',
      membership: membership({ status: 'disabled' }),
    });
    const result = await service.preflight({ ...baseInput, phase: 'wake' });
    expect(result.proceed).toBe(false);
    expect(result.accessDecision.reasonCode).toBe('SUBJECT_DISABLED');
  });

  it('Readiness blocker 与 AccessDecision 分离：额度不足时 access 仍 allow 但 ready=false', async () => {
    const result = await buildService({ billing: { ok: false, code: 'quota', reason: '额度已用尽' } })
      .preflight(baseInput);
    expect(result.accessDecision.verdict).toBe('allow');
    expect(result.readiness.ready).toBe(false);
    expect(result.readiness.billingAllowed).toBe(false);
    expect(result.readiness.blockers.map(b => b.code)).toContain('QUOTA_EXHAUSTED');
    expect(result.shadowWouldBlock).toBe(true);
    expect(result.proceed).toBe(true);
  });

  it('模型不可用进入 Readiness blocker，不污染 accessDecision', async () => {
    const result = await buildService({ modelAvailable: false }).preflight(baseInput);
    expect(result.accessDecision.verdict).toBe('allow');
    expect(result.readiness.blockers.map(b => b.code)).toContain('MODEL_UNAVAILABLE');
  });

  it('个人 Agent 路径走 entitlement+tenant policy，owner mismatch 拒绝', async () => {
    const service = buildService({ policies: [policyRecord(false)] });
    const result = await service.preflight({ ...baseInput, orgAgentId: undefined });
    expect(result.accessDecision.action).toBe('personal_agent.run');
    expect(result.accessDecision.reasonCode).toBe('TENANT_POLICY_DISABLED');
    expect(result.snapshot.agent).toEqual({ type: 'personal_agent', id: 'user-1' });
  });

  it('governance 数据缺失时生成 ACCESS_EVALUATION_UNAVAILABLE 决定，shadow 不阻断', async () => {
    const service = buildService({ membership: null });
    const result = await service.preflight(baseInput);
    expect(result.accessDecision.reasonCode).toBe('ACCESS_EVALUATION_UNAVAILABLE');
    expect(result.proceed).toBe(true);
    expect(result.shadowWouldBlock).toBe(true);
  });
});

describe('Run Resolution Snapshot 敏感内容围栏', () => {
  const cleanDraft = {
    runId: 'run-1',
    sessionId: 'session-1',
    tenantId: 'tenant-1',
    enforcementMode: 'shadow' as const,
    actor: { subjectType: 'human' as const, subjectId: 'user-1', tenantId: 'tenant-1' },
    accessDecision: {} as never,
    readiness: {} as never,
    agent: { type: 'org_agent' as const, id: 'oa-1' },
    skills: [],
    connectors: [],
    credentialBindings: [],
    memoryScopes: [],
    resolvedAt: NOW,
  };

  it('合法快照通过校验', () => {
    expect(() => assertRunSnapshotHasNoSensitivePayload(cleanDraft)).not.toThrow();
  });

  it('migration V5 创建 runtime_run_resolution_snapshots 表，Store 无更新/删除 API', async () => {
    const queries: string[] = [];
    const query = async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT version FROM')) return { rows: [{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 6 }] };
      return { rows: [], rowCount: 0 };
    };
    const pool = { query, connect: async () => ({ query, release: () => undefined }) };
    const store = new PgRunResolutionSnapshotStore(pool as never, 'test');
    await store.init();
    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_run_resolution_snapshots');
    expect(sql).toContain('snapshot_digest TEXT NOT NULL');
    expect(sql).toContain("enforcement_mode TEXT NOT NULL CHECK (enforcement_mode IN ('shadow', 'enforce'))");
    expect(queries.filter(item => item === 'INSERT INTO test_governance_schema_versions (version) VALUES ($1)')).toHaveLength(1);
    // append-only 合同：公开 API 只有 append/get/init
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(store)).sort())
      .toEqual(['append', 'constructor', 'get', 'init']);
  });

  it.each([
    ['wakeMessage', { wakeMessage: { content: 'hi' } }],
    ['content', { readiness: { note: 'ok' }, content: '消息正文' }],
    ['secret', { credentials: [{ secretValue: 'x' }] }],
    ['token', { nested: { token: 'abc' } }],
    ['rawParams', { tool: { rawParams: { foo: 1 } } }],
    ['memoryText', { memory: [{ memoryText: '用户偏好…' }] }],
  ])('包含 %s 时拒绝写入', (_label, patch) => {
    const dirty = JSON.parse(JSON.stringify({ ...cleanDraft, ...patch }));
    expect(() => assertRunSnapshotHasNoSensitivePayload(dirty)).toThrow(/RUN_SNAPSHOT_SENSITIVE_FIELD/);
  });
});
