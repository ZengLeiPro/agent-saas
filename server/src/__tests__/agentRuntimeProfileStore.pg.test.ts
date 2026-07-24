import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getBuiltinProfileByBinding } from '../data/agentProfiles/builtins.js';
import { AgentRuntimeProfileError, digestAgentRuntimeProfileConfig } from '../data/agentProfiles/types.js';
import { PgAgentRuntimeProfileStore } from '../data/agentProfiles/store.js';

const connectionString = process.env.AGENT_PROFILE_TEST_PG_URL;
const describePg = connectionString ? describe : describe.skip;
const prefix = `arp_test_${randomUUID().replaceAll('-', '_')}`;
const pool = connectionString ? new pg.Pool({ connectionString }) : null;
const store = pool ? new PgAgentRuntimeProfileStore({ pool, tablePrefix: prefix }) : null;

describePg('PgAgentRuntimeProfileStore contract', () => {
  beforeAll(async () => {
    const second = new PgAgentRuntimeProfileStore({ pool: pool!, tablePrefix: prefix });
    await Promise.all([store!.init(), second.init()]);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP TABLE IF EXISTS ${store!.bindingsTable}`);
    await pool.query(`ALTER TABLE ${store!.profilesTable} DROP CONSTRAINT IF EXISTS ${store!.profilesTable}_latest_version_fk`);
    await pool.query(`DROP TABLE IF EXISTS ${store!.versionsTable}`);
    await pool.query(`DROP TABLE IF EXISTS ${store!.profilesTable}`);
    await pool.query(`DROP FUNCTION IF EXISTS ${prefix}_reject_agent_profile_version_mutation()`);
    await pool.end();
  });

  it('seeds immutable system profiles, including Shell-first v2 upgrades, idempotently', async () => {
    const profiles = await store!.listProfiles();
    const bindings = await store!.listBindings();
    expect(profiles.filter((profile) => profile.systemProfile)).toHaveLength(5);
    for (const profileKey of ['memory_poll', 'subagent_explore']) {
      const profile = profiles.find((item) => item.profileKey === profileKey)!;
      expect(profile.latestVersion?.versionNumber).toBe(2);
      expect((await store!.listVersions(profile.profileId)).map((version) => version.versionNumber)).toEqual([2, 1]);
      expect(profile.draftConfig.tools.allowlist).toContain('Shell');
    }
    expect(bindings.map((binding) => binding.bindingKey)).toEqual([
      'background_explore', 'background_general', 'main', 'memory_poll',
      'org_agent', 'subagent_explore', 'subagent_general',
    ]);
    const before = bindings.find((binding) => binding.bindingKey === 'main');
    await store!.init();
    expect((await store!.listBindings()).find((binding) => binding.bindingKey === 'main')).toEqual(before);
    expect((await store!.listProfiles()).find((profile) => profile.profileKey === 'memory_poll')?.latestVersion?.versionNumber).toBe(2);
  });

  it('upgrades an untouched system v1 to v2 but preserves an admin-modified draft', async () => {
    const isolatedPrefix = `arpu_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const isolated = new PgAgentRuntimeProfileStore({ pool: pool!, tablePrefix: isolatedPrefix });
    try {
      await isolated.init();
      const memory = (await isolated.listProfiles()).find((profile) => profile.profileKey === 'memory_poll')!;
      const versions = await isolated.listVersions(memory.profileId);
      const v1 = versions.find((version) => version.versionNumber === 1)!;
      const v2 = versions.find((version) => version.versionNumber === 2)!;

      await pool!.query(`
        UPDATE ${isolated.profilesTable}
        SET latest_version_id=$2, draft_config=$3::jsonb, draft_digest=$4, revision=1
        WHERE profile_id=$1
      `, [memory.profileId, v1.profileVersionId, JSON.stringify(v1.config), v1.configDigest]);
      await isolated.init();
      expect((await isolated.getProfile(memory.profileId))?.latestVersion?.profileVersionId).toBe(v2.profileVersionId);

      const customized = structuredClone(v1.config);
      customized.context.systemInstructions = '管理员保留的未发布草稿';
      const customizedDigest = digestAgentRuntimeProfileConfig(customized);
      await pool!.query(`
        UPDATE ${isolated.profilesTable}
        SET latest_version_id=$2, draft_config=$3::jsonb, draft_digest=$4, revision=7
        WHERE profile_id=$1
      `, [memory.profileId, v1.profileVersionId, JSON.stringify(customized), customizedDigest]);
      await isolated.init();
      const preserved = await isolated.getProfile(memory.profileId);
      expect(preserved?.latestVersion?.profileVersionId).toBe(v1.profileVersionId);
      expect(preserved?.draftDigest).toBe(customizedDigest);
      expect(preserved?.revision).toBe(7);
    } finally {
      await pool!.query(`DROP TABLE IF EXISTS ${isolated.bindingsTable}`);
      await pool!.query(`ALTER TABLE ${isolated.profilesTable} DROP CONSTRAINT IF EXISTS ${isolated.profilesTable}_latest_version_fk`);
      await pool!.query(`DROP TABLE IF EXISTS ${isolated.versionsTable}`);
      await pool!.query(`DROP TABLE IF EXISTS ${isolated.profilesTable}`);
      await pool!.query(`DROP FUNCTION IF EXISTS ${isolatedPrefix}_reject_agent_profile_version_mutation()`);
    }
  });

  it('creates a draft, publishes immutable versions, and keeps v1 unchanged', async () => {
    const config = structuredClone(getBuiltinProfileByBinding('main').version.config);
    const profile = await store!.createProfile({
      profileKey: 'pg_contract',
      name: 'PG 契约 Profile',
      config,
      actor: 'admin',
    });
    expect(profile.status).toBe('draft');

    const v1 = await store!.publish(profile.profileId, profile.revision, 'admin');
    expect(v1.versionNumber).toBe(1);
    const afterV1 = (await store!.getProfile(profile.profileId))!;
    const nextConfig = structuredClone(afterV1.draftConfig);
    nextConfig.context.systemInstructions = '第二版职责';
    const edited = await store!.updateDraft(profile.profileId, {
      expectedRevision: afterV1.revision,
      config: nextConfig,
      actor: 'admin',
    });
    const v2 = await store!.publish(profile.profileId, edited.revision, 'admin');
    expect(v2.versionNumber).toBe(2);
    expect((await store!.getVersion(v1.profileVersionId))?.config.context.systemInstructions).toBe('');
    expect((await store!.getVersion(v2.profileVersionId))?.config.context.systemInstructions).toBe('第二版职责');

    const afterV2 = (await store!.getProfile(profile.profileId))!;
    const rollbackDraft = await store!.updateDraft(profile.profileId, {
      expectedRevision: afterV2.revision,
      config,
      actor: 'admin',
    });
    const v3 = await store!.publish(profile.profileId, rollbackDraft.revision, 'admin');
    expect(v3.versionNumber).toBe(3);
    expect(v3.configDigest).toBe(v1.configDigest);
    expect((await store!.getVersion(v1.profileVersionId))?.publishedBy).toBe('admin');

    await expect(pool!.query(
      `UPDATE ${store!.versionsTable} SET published_by='tampered' WHERE profile_version_id=$1`,
      [v1.profileVersionId],
    )).rejects.toMatchObject({ code: '55000' });
    await expect(pool!.query(
      `DELETE FROM ${store!.versionsTable} WHERE profile_version_id=$1`,
      [v1.profileVersionId],
    )).rejects.toMatchObject({ code: '55000' });
  });

  it('enforces optimistic revision, published-only binding, and bound archive guard', async () => {
    const draft = await store!.createProfile({ profileKey: 'binding_guard', name: '绑定门禁', actor: 'admin' });
    await expect(store!.updateBinding('main', draft.profileId, 'admin')).rejects.toMatchObject({
      code: 'PROFILE_NOT_PUBLISHED',
    });
    await expect(store!.updateDraft(draft.profileId, { expectedRevision: 99, name: '冲突', actor: 'admin' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    await store!.publish(draft.profileId, draft.revision, 'admin');
    const published = (await store!.getProfile(draft.profileId))!;
    await store!.updateBinding('main', draft.profileId, 'admin');
    await expect(store!.archive(draft.profileId, published.revision, 'admin')).rejects.toBeInstanceOf(AgentRuntimeProfileError);
  });

  it('serializes binding and archive so an archived Profile can never become newly bound', async () => {
    const draft = await store!.createProfile({ profileKey: 'binding_archive_race', name: '绑定归档竞态', actor: 'admin' });
    await store!.publish(draft.profileId, draft.revision, 'admin');
    const published = (await store!.getProfile(draft.profileId))!;
    const results = await Promise.allSettled([
      store!.updateBinding('main', draft.profileId, 'admin'),
      store!.archive(draft.profileId, published.revision, 'admin'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const profile = (await store!.getProfile(draft.profileId))!;
    const binding = (await store!.listBindings()).find((item) => item.bindingKey === 'main');
    expect(profile.status === 'published' ? binding?.profileId === profile.profileId : binding?.profileId !== profile.profileId)
      .toBe(true);
  });
});
