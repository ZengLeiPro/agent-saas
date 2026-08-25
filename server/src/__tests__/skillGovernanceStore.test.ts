import { describe, expect, it } from 'vitest';

import { PgSkillGovernanceStore, assertGovernedSkillDefinitionSafe } from '../data/skillGovernance/index.js';

const NOW = '2026-08-08T00:00:00.000Z';

function resourceRow(overrides: Record<string, unknown> = {}) {
  return {
    skill_id: 'sales-helper', tenant_id: 'acme', scope: 'tenant', owner_user_id: null,
    status: 'draft', current_version_id: null, revision: '1', created_at: NOW,
    created_by: 'admin', updated_at: NOW, updated_by: 'admin', ...overrides,
  };
}

function buildPool() {
  const resources = new Map<string, Record<string, unknown>>();
  const versions: Record<string, unknown>[] = [];
  const candidates = new Map<string, Record<string, unknown>>();
  const queries: string[] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (sql.includes('SELECT version FROM')) return { rows: [], rowCount: 0 };
    if (sql.includes('INSERT INTO test_governed_skills') && sql.includes('RETURNING')) {
      if (resources.has(String(params[0]))) return { rows: [], rowCount: 0 };
      const row = resourceRow({
        skill_id: params[0], tenant_id: params[1], scope: params[2], owner_user_id: params[3],
        created_by: params[4], updated_by: params[4],
      });
      resources.set(String(params[0]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes("version.definition_json->>'legacySkillId'=$3")) {
      const matching = versions
        .filter(version => (version.definition_json as Record<string, unknown>)?.legacySkillId === params[2])
        .map(version => resources.get(String(version.skill_id)))
        .filter((resource): resource is Record<string, unknown> => Boolean(resource));
      const personal = matching.some(resource => (
        resource.scope === 'personal'
        && resource.tenant_id === params[0]
        && resource.owner_user_id === params[1]
      ));
      const nonPersonal = matching.some(resource => (
        resource.scope === 'tenant' && resource.tenant_id === params[0]
      ));
      return { rows: [{ personal, non_personal: nonPersonal }], rowCount: 1 };
    }
    if (sql.includes('FROM test_governed_skills') && /skill_id\s*=\s*\$1/.test(sql)) {
      const row = resources.get(String(params[0]));
      const sameTenant = !sql.includes('tenant_id=$2') || row?.tenant_id === params[1];
      const eligibleScope = !sql.includes("scope<>'personal'") || row?.scope !== 'personal';
      const visible = row && sameTenant && eligibleScope ? row : undefined;
      return { rows: visible ? [visible] : [], rowCount: visible ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO test_skill_candidates') && sql.includes('RETURNING')) {
      const row = {
        candidate_id: params[0], tenant_id: params[1], owner_user_id: params[2], target_skill_id: params[3],
        definition_json: JSON.parse(String(params[4])), digest: params[5], status: 'draft', revision: '1',
        submitted_at: null, reviewed_at: null, reviewed_by: null, review_reason: null,
        published_version_id: null, created_at: NOW, updated_at: NOW,
      };
      candidates.set(String(params[0]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('FROM test_skill_candidates') && /candidate_id\s*=\s*\$[12]/.test(sql)) {
      const idIndex = sql.includes('tenant_id=$1') ? 1 : 0;
      const row = candidates.get(String(params[idIndex]));
      const visible = row && (!sql.includes('tenant_id=$1') || row.tenant_id === params[0]) ? row : undefined;
      return { rows: visible ? [visible] : [], rowCount: visible ? 1 : 0 };
    }
    if (sql.includes('UPDATE test_skill_candidates') && sql.includes("SET status='submitted'")) {
      const current = candidates.get(String(params[1]));
      if (!current || current.tenant_id !== params[0] || current.owner_user_id !== params[2] || Number(current.revision) !== Number(params[3]) || current.status !== 'draft') return { rows: [], rowCount: 0 };
      const row = { ...current, status: 'submitted', revision: String(Number(current.revision) + 1), submitted_at: NOW };
      candidates.set(String(params[1]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_skill_candidates') && sql.includes('reviewed_at=NOW()')) {
      expect(sql).toContain('SET status=$3');
      expect(sql).toContain('reviewed_by=$4');
      expect(sql).toContain('review_reason=$5');
      const current = candidates.get(String(params[1]));
      if (!current || current.tenant_id !== params[0] || Number(current.revision) !== Number(params[5]) || current.status !== 'submitted') return { rows: [], rowCount: 0 };
      const row = { ...current, status: params[2], revision: String(Number(current.revision) + 1), reviewed_at: NOW, reviewed_by: params[3], review_reason: params[4] };
      candidates.set(String(params[1]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('LEFT JOIN test_governed_skill_versions')) {
      const rows = [...resources.values()]
        .filter(resource => resource.tenant_id === params[0] && resource.scope === 'tenant')
        .flatMap(resource => {
          const resourceVersions = versions.filter(version => version.skill_id === resource.skill_id);
          return resourceVersions.length > 0
            ? resourceVersions.map(version => ({
                skill_id: resource.skill_id,
                definition_json: version.definition_json,
              }))
            : [{ skill_id: resource.skill_id, definition_json: null }];
        });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('FROM test_governed_skill_versions') && sql.includes('digest=$2')) {
      const row = versions.find(item => item.skill_id === params[0] && item.digest === params[1]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('FROM test_governed_skill_versions') && sql.includes('ORDER BY version_number')) {
      const rows = versions
        .filter(item => item.skill_id === params[0])
        .sort((a, b) => Number(a.version_number) - Number(b.version_number));
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('MAX(version_number)')) {
      const max = versions.filter(item => item.skill_id === params[0]).reduce((n, item) => Math.max(n, Number(item.version_number)), 0);
      return { rows: [{ next_version: String(max + 1) }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO test_governed_skill_versions') && sql.includes('RETURNING')) {
      const row = {
        version_id: params[0], skill_id: params[1], version_number: String(params[2]),
        definition_json: JSON.parse(String(params[3])), digest: params[4], source_candidate_id: params[5],
        published_at: NOW, published_by: params[6],
      };
      versions.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_governed_skills') && sql.includes("status='published'")) {
      const current = resources.get(String(params[0]));
      if (!current || Number(current.revision) !== Number(params[3])) return { rows: [], rowCount: 0 };
      const row = { ...current, status: 'published', current_version_id: params[1], revision: String(Number(current.revision) + 1), updated_by: params[2] };
      resources.set(String(params[0]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_skill_candidates') && sql.includes("status='published'")) {
      const current = candidates.get(String(params[1]));
      if (!current || current.tenant_id !== params[0] || Number(current.revision) !== Number(params[3]) || current.status !== 'approved') return { rows: [], rowCount: 0 };
      const row = { ...current, status: 'published', revision: String(Number(current.revision) + 1), published_version_id: params[2] };
      candidates.set(String(params[1]), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE test_governed_skills') && sql.includes("status='retired'")) {
      const current = resources.get(String(params[1]));
      if (!current || current.tenant_id !== params[0] || Number(current.revision) !== Number(params[2]) || current.status === 'retired') return { rows: [], rowCount: 0 };
      const row = { ...current, status: 'retired', revision: String(Number(current.revision) + 1), updated_by: params[3] };
      resources.set(String(params[1]), row);
      return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release: () => undefined }) };
  return { pool: pool as never, resources, versions, candidates, queries };
}

const definition = {
  name: '销售助手', description: '查询销售流程', contentRef: 'skill-content://sha256/abc',
  legacySkillId: 'sales-helper', contentDigest: 'history-v1',
  entrypoint: 'SKILL.md', toolRequirements: ['WebSearch'],
};

describe('Governed Skill + Candidate 发布链', () => {
  it('migration V10 创建 Skill、immutable Version 与候选审批表', async () => {
    const { pool, queries } = buildPool();
    const store = new PgSkillGovernanceStore({ pool, tablePrefix: 'test' });
    await store.init();
    const sql = queries.join('\n');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_governed_skills');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_governed_skill_versions');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS test_skill_candidates');
    expect(sql).toContain("status IN ('draft', 'submitted', 'approved', 'rejected', 'published')");
    expect(queries.filter(item => item === 'BEGIN')).toHaveLength(31);
  });

  it('personal Skill 强制 immutable owner；tenant Skill 建 stable ID', async () => {
    const { pool } = buildPool();
    const store = new PgSkillGovernanceStore({ pool, tablePrefix: 'test' });
    await expect(store.createResource({ skillId: 'personal-skill', tenantId: 'acme', scope: 'personal', createdBy: 'user-1' }))
      .rejects.toMatchObject({ code: 'SKILL_PERSONAL_OWNER_REQUIRED' });
    const created = await store.createResource({
      skillId: 'sales-helper', tenantId: 'acme', scope: 'tenant', createdBy: 'admin',
    });
    expect(created).toMatchObject({ skillId: 'sales-helper', scope: 'tenant', status: 'draft', revision: 1 });
  });

  it('按目标 legacySkillId 返回完整的个人或非个人 ownership 结论', async () => {
    const { pool, resources, versions } = buildPool();
    resources.set('tenant-foreign', resourceRow({
      skill_id: 'tenant-foreign', tenant_id: 'foreign', scope: 'tenant', status: 'published',
    }));
    resources.set('tenant-owned', resourceRow({
      skill_id: 'tenant-owned', tenant_id: 'acme', scope: 'tenant', status: 'published',
    }));
    resources.set('platform-owned', resourceRow({
      skill_id: 'platform-owned', tenant_id: 'pantheon', scope: 'platform', status: 'published',
    }));
    resources.set('personal-owned', resourceRow({
      skill_id: 'personal-owned', tenant_id: 'acme', scope: 'personal', owner_user_id: 'user-1',
      status: 'published',
    }));
    versions.push(
      { skill_id: 'tenant-foreign', definition_json: { legacySkillId: 'legacy-foreign' } },
      { skill_id: 'tenant-owned', definition_json: { legacySkillId: 'legacy-tenant' } },
      { skill_id: 'platform-owned', definition_json: { legacySkillId: 'legacy-platform' } },
      { skill_id: 'personal-owned', definition_json: { legacySkillId: 'legacy-personal' } },
    );
    const store = new PgSkillGovernanceStore({ pool, tablePrefix: 'test' });

    await expect(store.resolveUserPersonalSkillOwnership('acme', 'user-1', 'legacy-foreign'))
      .resolves.toBeUndefined();
    await expect(store.resolveUserPersonalSkillOwnership('acme', 'user-1', 'legacy-tenant'))
      .resolves.toBe('not_personal');
    await expect(store.resolveUserPersonalSkillOwnership('acme', 'user-1', 'legacy-platform'))
      .resolves.toBeUndefined();
    await expect(store.resolveUserPersonalSkillOwnership('acme', 'user-1', 'legacy-personal'))
      .resolves.toBe('personal');
    await expect(store.resolveUserPersonalSkillOwnership('acme', 'user-1', 'legacy-unknown'))
      .resolves.toBeUndefined();
  });

  it('治理上传可在单一事务内创建 tenant Skill 并发布 immutable v1', async () => {
    const { pool, resources, versions, queries } = buildPool();
    const store = new PgSkillGovernanceStore({ pool, tablePrefix: 'test' });
    const result = await store.createAndPublishResource({
      skillId: 'uploaded-skill',
      tenantId: 'acme',
      scope: 'tenant',
      definition: { ...definition, source: 'governance_upload' },
      createdBy: 'org-admin',
    });

    expect(result).toMatchObject({
      created: true,
      resource: { skillId: 'uploaded-skill', tenantId: 'acme', status: 'published', revision: 2 },
      version: { skillId: 'uploaded-skill', versionNumber: 1 },
    });
    expect(resources.get('uploaded-skill')).toMatchObject({ status: 'published', current_version_id: expect.any(String) });
    expect(versions).toHaveLength(1);
    await expect(store.listVersions('uploaded-skill')).resolves.toMatchObject([
      { skillId: 'uploaded-skill', versionNumber: 1 },
    ]);
    const history = await store.listTenantSkillHistoricalProvenance('acme');
    expect(history.get('sales-helper')).toEqual({ digests: [], legacyDigests: ['history-v1'] });
    expect(queries.filter(query => query === 'BEGIN')).toHaveLength(1);
    expect(queries.filter(query => query === 'COMMIT')).toHaveLength(1);
  });

  it('新摘要算法带标记，历史查询不把它降级为旧摘要', async () => {
    const { pool } = buildPool();
    const store = new PgSkillGovernanceStore({ pool, tablePrefix: 'test' });
    await store.createAndPublishResource({
      skillId: 'current-skill',
      tenantId: 'acme',
      scope: 'tenant',
      definition: {
        ...definition,
        legacySkillId: 'current-skill',
        contentDigest: 'current-v2',
        contentDigestAlgorithm: 'materialized-v2',
      },
      createdBy: 'org-admin',
    });
    const history = await store.listTenantSkillHistoricalProvenance('acme');
    expect(history.get('current-skill')).toEqual({ digests: ['current-v2'], legacyDigests: [] });
  });

  it('个人候选副本按 draft→submitted→approved→published，发布 immutable version', async () => {
    const { pool, versions, queries } = buildPool();
    const store = new PgSkillGovernanceStore({ pool, tablePrefix: 'test' });
    await store.createResource({ skillId: 'sales-helper', tenantId: 'acme', scope: 'tenant', createdBy: 'admin' });
    const candidate = await store.createCandidate({
      tenantId: 'acme', ownerUserId: 'user-1', targetSkillId: 'sales-helper', definition,
    });
    const submitted = await store.submitCandidate('acme', candidate.candidateId, 'user-1', 1);
    expect(submitted.status).toBe('submitted');
    const approved = await store.reviewCandidate({
      tenantId: 'acme', candidateId: candidate.candidateId, expectedRevision: 2, verdict: 'approved', reviewedBy: 'org-admin', reason: '通过测试',
    });
    expect(approved.status).toBe('approved');
    const published = await store.publishApprovedCandidate({
      tenantId: 'acme', candidateId: candidate.candidateId, expectedCandidateRevision: 3, expectedSkillRevision: 1, publishedBy: 'org-admin',
    });
    expect(published.candidate).toMatchObject({ status: 'published', revision: 4 });
    expect(published.resource).toMatchObject({ status: 'published', revision: 2 });
    expect(published.version).toMatchObject({ sourceCandidateId: candidate.candidateId, versionNumber: 1 });
    expect(versions).toHaveLength(1);
    const guardedCandidateUpdates = queries.filter(sql =>
      sql.includes('UPDATE test_skill_candidates') && !sql.includes("status='published'"));
    expect(guardedCandidateUpdates).toHaveLength(2);
    expect(guardedCandidateUpdates.every(sql => sql.includes("target.scope<>'personal'"))).toBe(true);
    expect(queries.some(sql => sql.includes('INSERT INTO test_skill_candidates') && sql.includes("target.scope<>'personal'"))).toBe(true);
    expect(queries.some(sql => sql.includes("scope<>'personal' FOR UPDATE"))).toBe(true);
  });

  it('候选目标 Skill 严格同租户，禁止跨租户提升', async () => {
    const { pool } = buildPool();
    const store = new PgSkillGovernanceStore({ pool, tablePrefix: 'test' });
    await store.createResource({ skillId: 'beta-skill', tenantId: 'beta', scope: 'tenant', createdBy: 'beta-admin' });
    await expect(store.createCandidate({
      tenantId: 'acme', ownerUserId: 'user-1', targetSkillId: 'beta-skill', definition,
    })).rejects.toMatchObject({ code: 'SKILL_RESOURCE_TENANT_MISMATCH' });
  });

  it('personal Skill candidate create/submit/review/publish 在 Store 层全部 fail closed', async () => {
    const { pool, resources, candidates, versions } = buildPool();
    const store = new PgSkillGovernanceStore({ pool, tablePrefix: 'test' });
    await store.createResource({
      skillId: 'personal-skill', tenantId: 'acme', scope: 'personal', ownerUserId: 'user-1', createdBy: 'user-1',
    });
    await expect(store.createCandidate({
      tenantId: 'acme', ownerUserId: 'user-1', targetSkillId: 'personal-skill', definition,
    })).rejects.toMatchObject({ code: 'SKILL_RESOURCE_NOT_FOUND' });
    expect(candidates.size).toBe(0);

    const candidateId = 'skillc-personal';
    const candidateRow = {
      candidate_id: candidateId, tenant_id: 'acme', owner_user_id: 'user-1', target_skill_id: 'personal-skill',
      definition_json: definition, digest: 'untrusted', status: 'draft', revision: '1',
      submitted_at: null, reviewed_at: null, reviewed_by: null, review_reason: null,
      published_version_id: null, created_at: NOW, updated_at: NOW,
    };
    candidates.set(candidateId, candidateRow);
    await expect(store.submitCandidate('acme', candidateId, 'user-1', 1))
      .rejects.toMatchObject({ code: 'SKILL_RESOURCE_NOT_FOUND' });

    candidates.set(candidateId, { ...candidateRow, status: 'submitted', revision: '2' });
    await expect(store.reviewCandidate({
      tenantId: 'acme', candidateId, expectedRevision: 2, verdict: 'approved', reviewedBy: 'admin', reason: 'no',
    })).rejects.toMatchObject({ code: 'SKILL_RESOURCE_NOT_FOUND' });

    candidates.set(candidateId, { ...candidateRow, status: 'approved', revision: '3' });
    await expect(store.publishApprovedCandidate({
      tenantId: 'acme', candidateId, expectedCandidateRevision: 3, expectedSkillRevision: 1, publishedBy: 'admin',
    })).rejects.toMatchObject({ code: 'SKILL_RESOURCE_NOT_FOUND' });
    expect(resources.get('personal-skill')).toMatchObject({ status: 'draft', revision: '1' });
    expect(candidates.get(candidateId)).toMatchObject({ status: 'approved', revision: '3' });
    expect(versions).toHaveLength(0);
  });

  it('候选 owner/version/状态错误均 fail closed', async () => {
    const { pool } = buildPool();
    const store = new PgSkillGovernanceStore({ pool, tablePrefix: 'test' });
    await store.createResource({ skillId: 'sales-helper', tenantId: 'acme', scope: 'tenant', createdBy: 'admin' });
    const candidate = await store.createCandidate({ tenantId: 'acme', ownerUserId: 'user-1', targetSkillId: 'sales-helper', definition });
    await expect(store.submitCandidate('acme', candidate.candidateId, 'user-2', 1))
      .rejects.toMatchObject({ code: 'SKILL_CANDIDATE_OWNER_MISMATCH' });
    await expect(store.reviewCandidate({
      tenantId: 'acme', candidateId: candidate.candidateId, expectedRevision: 1, verdict: 'approved', reviewedBy: 'admin', reason: 'skip submit',
    })).rejects.toMatchObject({ code: 'SKILL_CANDIDATE_INVALID_TRANSITION' });
  });

  it('Skill Definition 禁止 Secret/Credential/运行实例与消息正文', () => {
    expect(() => assertGovernedSkillDefinitionSafe(definition)).not.toThrow();
    for (const invalid of [
      { secretRef: 'ref-1' }, { credentialId: 'cred-1' }, { api_key: 'key' }, { clientSecret: 'secret' },
      { workspaceId: 'ws-1' }, { messageText: '正文' },
    ]) {
      expect(() => assertGovernedSkillDefinitionSafe(invalid))
        .toThrowError(expect.objectContaining({ code: 'SKILL_DEFINITION_SENSITIVE' }));
    }
  });
});
