import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_ORG_AGENT_RUNTIME_POLICY } from '../data/orgAgents/runtimePolicy.js';
import {
  createOrgAgentSessionSnapshot,
  createRuntimeSessionRecord,
  FileSessionCatalog,
  resolveSessionMemoryPolicy,
} from '../runtime/sessionCatalog.js';

describe('FileSessionCatalog compatibility', () => {
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    for (const dir of cleanupDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    cleanupDirs.clear();
  });

  it('restores taskboard sessions from meta before the legacy transcript exists', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-catalog-meta-'));
    cleanupDirs.add(cwd);

    const sessionId = `taskboard-${randomUUID()}`;
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const record = createRuntimeSessionRecord({
      sessionId,
      userId: 'user-1',
      username: 'alice',
      userRole: 'admin',
      channel: 'web',
      cwd,
      modelRef: 'gpt-5.4-mini',
      executionTarget: 'server-local',
      status: 'running',
    });
    cleanupDirs.add(dirname(record.transcriptPath));

    await catalog.upsert(record);

    await expect(catalog.get(sessionId)).resolves.toMatchObject({
      sessionId,
      userId: 'user-1',
      username: 'alice',
      userRole: 'admin',
      channel: 'web',
      cwd,
      transcriptPath: record.transcriptPath,
      modelRef: 'gpt-5.4-mini',
      sandboxProfile: 'daily',
      executionTarget: 'server-local',
      status: 'running',
    });
  });

  it('defaults new records to interactive but preserves missing workload on legacy projections', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-catalog-workload-'));
    cleanupDirs.add(cwd);
    const sessionId = randomUUID();
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const created = createRuntimeSessionRecord({ sessionId, userId: 'u1', username: 'alice', channel: 'web', cwd });
    // 新建默认值与 legacy 缺省投影分别覆盖两条兼容路径。
    expect(created.sandboxWorkloadDescriptor).toEqual({ kind: 'interactive' });
    cleanupDirs.add(dirname(created.transcriptPath));
    const { sandboxWorkloadDescriptor: _legacyMissing, ...legacy } = created;
    await catalog.upsert(legacy);
    expect((await catalog.get(sessionId))?.sandboxWorkloadDescriptor).toBeUndefined();
  });

  it('does not overwrite a persisted workload descriptor with an older Run projection', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-catalog-sticky-workload-'));
    cleanupDirs.add(cwd);
    const sessionId = randomUUID();
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const current = createRuntimeSessionRecord({
      sessionId,
      userId: 'u1',
      username: 'alice',
      channel: 'web',
      cwd,
      sandboxWorkloadDescriptor: { kind: 'interactive' },
    });
    cleanupDirs.add(dirname(current.transcriptPath));
    await catalog.upsert(current);

    await catalog.upsert({
      ...current,
      updatedAt: new Date(Date.parse(current.updatedAt) + 1_000).toISOString(),
      sandboxWorkloadDescriptor: { kind: 'cron' },
    });

    expect((await catalog.get(sessionId))?.sandboxWorkloadDescriptor).toEqual({ kind: 'interactive' });
  });

  it('recovers agent-dws-session（钉钉成员会话）meta，使后台 Agent 派发能解析到父会话', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-catalog-dws-'));
    cleanupDirs.add(cwd);

    const sessionId = `agent-dws-session-${randomUUID()}`;
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const record = createRuntimeSessionRecord({
      sessionId,
      userId: 'adws-1',
      username: 'agent-dws:org-kaikai',
      userRole: 'user',
      tenantId: 'tenant-a',
      channel: 'dingtalk',
      cwd,
      orgAgentId: 'org-kaikai',
      status: 'running',
    });
    cleanupDirs.add(dirname(record.transcriptPath));

    await catalog.upsert(record);

    // 回归（TASK-78）：根因是 isValidSessionId 白名单缺失 agent-dws-session- 前缀，
    // 导致 backgroundTaskService.enqueue 里 sessionCatalog.get(parentSessionId) 永远
    // 返回 null，抛出「父会话不存在」且 recoverable:false。这里必须能按 id 找回。
    await expect(catalog.get(sessionId)).resolves.toMatchObject({
      sessionId,
      userId: 'adws-1',
      username: 'agent-dws:org-kaikai',
      channel: 'dingtalk',
      orgAgentId: 'org-kaikai',
      tenantId: 'tenant-a',
    });
  });

  it('持久化当前 run 的组织 Agent 安全快照，供 approval/interaction resume 固定复用', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-catalog-org-agent-'));
    cleanupDirs.add(cwd);
    const sessionId = randomUUID();
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const orgAgentSnapshot = createOrgAgentSessionSnapshot({
      name: '开开',
      instructions: '只处理组织任务',
      allowedSkills: ['dws'],
      allowedKnowledge: ['company'],
      runtime: DEFAULT_ORG_AGENT_RUNTIME_POLICY,
    }, [{ collectionId: 'collection-a', assignmentVersion: 7, resourceType: 'org_knowledge' }]);
    const record = createRuntimeSessionRecord({
      sessionId,
      userId: 'adws-1',
      username: 'agent-dws:org-kaikai',
      channel: 'dingtalk',
      cwd,
      orgAgentId: 'org-kaikai',
      orgAgentSnapshot,
    });
    cleanupDirs.add(dirname(record.transcriptPath));

    await catalog.upsert(record);

    await expect(catalog.get(sessionId)).resolves.toMatchObject({
      orgAgentId: 'org-kaikai',
      orgAgentSnapshot: {
        name: '开开',
        instructions: '只处理组织任务',
        allowedSkills: ['dws'],
        allowedKnowledge: ['company'],
        collectionAssignments: [{ collectionId: 'collection-a', assignmentVersion: 7, resourceType: 'org_knowledge' }],
      },
    });
  });

  it('ensure only creates the first session meta and never regresses a terminal status or policy pin', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-catalog-ensure-'));
    cleanupDirs.add(cwd);
    const sessionId = randomUUID();
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const record = createRuntimeSessionRecord({
      sessionId,
      userId: 'user-1',
      username: 'alice',
      channel: 'web',
      cwd,
      status: 'running',
      memoryPolicyVersion: 'v2',
    });
    cleanupDirs.add(dirname(record.transcriptPath));

    await Promise.all([catalog.ensure(record), catalog.ensure(record)]);
    await catalog.markStatus(sessionId, 'finished');
    await catalog.ensure({
      ...record,
      username: 'stale-worker',
      status: 'running',
      memoryPolicyVersion: 'v1',
    });

    await expect(catalog.get(sessionId)).resolves.toMatchObject({
      username: 'alice',
      status: 'finished',
      memoryPolicyVersion: 'v2',
    });
  });
});

const policyCleanupDirs = new Set<string>();
afterEach(async () => {
  for (const dir of policyCleanupDirs) await rm(dir, { recursive: true, force: true });
  policyCleanupDirs.clear();
});

describe('session memory policy persistence', () => {
  it.each(['v1', 'v2'] as const)('round-trips explicit %s pins', async (memoryPolicyVersion) => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-policy-'));
    policyCleanupDirs.add(cwd);
    const sessionId = randomUUID();
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const record = createRuntimeSessionRecord({
      sessionId, userId: 'u1', username: 'alice', channel: 'web', cwd, memoryPolicyVersion,
    });
    policyCleanupDirs.add(dirname(record.transcriptPath));
    await catalog.upsert(record);
    await expect(catalog.get(sessionId)).resolves.toMatchObject({ memoryPolicyVersion });
  });

  it('keeps legacy missing pins absent so policy resolution defaults them to v1', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-policy-legacy-'));
    policyCleanupDirs.add(cwd);
    const sessionId = randomUUID();
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const record = createRuntimeSessionRecord({ sessionId, userId: 'u1', username: 'alice', channel: 'web', cwd });
    policyCleanupDirs.add(dirname(record.transcriptPath));
    await catalog.upsert(record);
    const restored = await catalog.get(sessionId);
    expect(restored?.memoryPolicyVersion).toBeUndefined();
  });

  it('upsert cannot rewrite an existing policy pin or relax no-automation', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-policy-monotonic-'));
    policyCleanupDirs.add(cwd);
    const sessionId = randomUUID();
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const record = createRuntimeSessionRecord({
      sessionId, userId: 'u1', username: 'alice', channel: 'web', cwd,
      memoryPolicyVersion: 'v2', memoryAutomationEligible: false,
    });
    policyCleanupDirs.add(dirname(record.transcriptPath));
    await catalog.upsert(record);
    await catalog.upsert({ ...record, memoryPolicyVersion: 'v1', memoryAutomationEligible: true });
    await expect(catalog.get(sessionId)).resolves.toMatchObject({
      memoryPolicyVersion: 'v2', memoryAutomationEligible: false,
    });
  });

  it('concurrent ordinary and TaskBoard upserts cannot race a v2/no-automation migration backwards', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-policy-race-'));
    policyCleanupDirs.add(cwd);
    const sessionId = `taskboard-${randomUUID()}`;
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const base = createRuntimeSessionRecord({
      sessionId, userId: 'u1', username: 'alice', channel: 'web', cwd, memoryPolicyVersion: 'v1',
    });
    policyCleanupDirs.add(dirname(base.transcriptPath));
    await catalog.upsert(base);
    await Promise.all([
      catalog.upsert({ ...base, memoryPolicyVersion: 'v1', memoryAutomationEligible: true }),
      catalog.upsert({
        ...base,
        sessionSource: 'taskboard_execution',
        memoryPolicyVersion: 'v2',
        memoryAutomationEligible: false,
      }),
    ]);
    await expect(catalog.get(sessionId)).resolves.toMatchObject({
      sessionSource: 'taskboard_execution', memoryPolicyVersion: 'v2', memoryAutomationEligible: false,
    });
  });

  it('persists the hidden memory consolidation source and no-automation flag', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-memory-consolidation-'));
    policyCleanupDirs.add(cwd);
    const sessionId = randomUUID();
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const record = createRuntimeSessionRecord({
      sessionId, userId: 'u1', username: 'alice', channel: 'web', cwd,
      memoryPolicyVersion: 'v1', toolProfile: 'memory_consolidate',
    });
    policyCleanupDirs.add(dirname(record.transcriptPath));
    await catalog.upsert(record);
    await expect(catalog.get(sessionId)).resolves.toMatchObject({
      memoryPolicyVersion: 'v1', sessionSource: 'memory_consolidation', memoryAutomationEligible: false,
    });
  });

  it('canonicalizes TaskBoard source to no-automation and read-only v2', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'session-policy-taskboard-'));
    policyCleanupDirs.add(cwd);
    const sessionId = `taskboard-${randomUUID()}`;
    const catalog = new FileSessionCatalog({ agentCwd: cwd });
    const record = createRuntimeSessionRecord({
      sessionId, userId: 'u1', username: 'alice', channel: 'web', cwd,
      memoryPolicyVersion: 'v1', sessionSource: 'taskboard_execution', memoryAutomationEligible: true,
    });
    policyCleanupDirs.add(dirname(record.transcriptPath));
    await catalog.upsert(record);
    await expect(catalog.get(sessionId)).resolves.toMatchObject({
      memoryPolicyVersion: 'v2', sessionSource: 'taskboard_execution', memoryAutomationEligible: false,
    });
  });
});

describe('resolveSessionMemoryPolicy', () => {
  it.each(['web', 'dingtalk'])('pins new direct %s sessions from the resolver', (channel) => {
    expect(resolveSessionMemoryPolicy({ delegationEnabled: true, channel })).toBe('v2');
    expect(resolveSessionMemoryPolicy({ delegationEnabled: false, channel })).toBe('v1');
  });

  it('never recomputes existing or legacy sessions', () => {
    expect(resolveSessionMemoryPolicy({ existing: { memoryPolicyVersion: 'v1' }, delegationEnabled: true, channel: 'web' })).toBe('v1');
    expect(resolveSessionMemoryPolicy({ existing: {}, delegationEnabled: true, channel: 'web' })).toBe('v1');
  });

  it('keeps TaskBoard read-only while disabling background automation', () => {
    expect(resolveSessionMemoryPolicy({
      delegationEnabled: true,
      channel: 'web',
      sessionSource: 'taskboard_execution',
      memoryAutomationEligible: false,
    })).toBe('v2');
  });

  it('keeps new background profiles and Org Agents on v1 without rewriting an existing v2 pin', () => {
    expect(resolveSessionMemoryPolicy({ delegationEnabled: true, channel: 'web', toolProfile: 'memory_poll' })).toBe('v1');
    expect(resolveSessionMemoryPolicy({ delegationEnabled: true, channel: 'dingtalk', orgAgentId: 'org-1' })).toBe('v1');
    expect(resolveSessionMemoryPolicy({
      existing: { memoryPolicyVersion: 'v2' }, delegationEnabled: false, channel: 'web', toolProfile: 'memory_poll',
    })).toBe('v2');
    expect(resolveSessionMemoryPolicy({
      existing: { memoryPolicyVersion: 'v2' }, delegationEnabled: false, channel: 'dingtalk', orgAgentId: 'org-1',
    })).toBe('v2');
  });
});
