import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PgHandStore, selectRuntimeHandRoute } from '../runtime/handStore.js';
import { supersedeLegacyHand } from '../runtime/handSupersession.js';
import {
  deriveTenantHandId,
  ensureRuntimeHandRegistered,
} from '../runtime/runtimeHandRegistration.js';

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)('legacy Hand upgrade on persistent PostgreSQL records', () => {
  const prefix = `handupgrade_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const store = new PgHandStore({ pool, tablePrefix: prefix });
  beforeAll(async () => {
    await store.init();
    await pool.query(
      `CREATE TABLE ${prefix}_runs (run_id TEXT PRIMARY KEY, tenant_id TEXT, status TEXT)`,
    );
    await pool.query(
      `CREATE TABLE ${prefix}_tool_invocations (run_id TEXT, tenant_id TEXT, status TEXT, metadata JSONB)`,
    );
  });
  afterAll(async () => {
    await pool.query(`DROP TABLE ${prefix}_tool_invocations, ${prefix}_runs, ${prefix}_hands`);
    await pool.end();
  });
  async function pair() {
    const sessionId = randomUUID();
    const legacyId = `${sessionId}:agent-saas-acs`;
    const newId = deriveTenantHandId('kaiyan', sessionId, 'agent-saas-acs');
    const input = {
      sessionId,
      tenantId: 'kaiyan',
      workspaceId: 'ws_kaiyan__user1',
      type: 'server-remote' as const,
      endpoint: 'http://acs.example',
      metadata: {
        tenantRemoteHandId: 'agent-saas-acs',
        provision: { lastStatus: 'ok' },
        recipe: {
          sessionId,
          workspaceId: 'ws_kaiyan__user1',
          sandboxScopeId: `scope-${sessionId}`,
          mountSubPath: 'workspaces/kaiyan/user1',
        },
      },
    };
    await store.register({ ...input, handId: legacyId, runId: `old-${sessionId}` });
    await store.register({ ...input, handId: newId, runId: `new-${sessionId}` });
    return { sessionId, legacyId, newId, input };
  }
  it('preserves history, retires the exact legacy identity once, and repairs sole routing', async () => {
    const p = await pair();
    expect(selectRuntimeHandRoute(await store.listBySession(p.sessionId, 'kaiyan'))).toMatchObject({
      kind: 'blocked',
      message: 'RUNTIME_HAND_AMBIGUOUS',
    });
    expect(await supersedeLegacyHand(pool, prefix, p.newId, 'kaiyan', false)).toMatchObject({
      outcome: 'superseded',
      reason: 'preview_only',
    });
    expect((await store.get(p.legacyId, 'kaiyan'))?.metadata.supersededBy).toBeUndefined();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => store.supersedeLegacyHand(p.newId, 'kaiyan')),
    );
    expect(results.filter((r) => r.outcome === 'superseded')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'already_superseded')).toHaveLength(3);
    expect(await store.listBySession(p.sessionId, 'kaiyan')).toHaveLength(2);
    expect(selectRuntimeHandRoute(await store.listBySession(p.sessionId, 'kaiyan'))).toMatchObject({
      kind: 'ready',
      handId: p.newId,
    });
    const snapshot = await store.get(p.legacyId, 'kaiyan');
    expect(snapshot?.status).toBe('ready');
    expect(await store.updateStatus(p.legacyId, 'unhealthy', {}, 'kaiyan')).toBeNull();
    expect(
      await store.completeProvisionAttempt(p.legacyId, 'old', 'ready', {}, 'kaiyan'),
    ).toBeNull();
    await expect(store.register({ ...p.input, handId: p.legacyId })).rejects.toThrow(/fence/);
    await store.sweepLeases();
    expect(await store.get(p.legacyId, 'kaiyan')).toEqual(snapshot);
    expect(
      (await store.listByType('server-remote', { status: 'ready' })).map((r) => r.handId),
    ).not.toContain(p.legacyId);
  });
  it.each(['running', 'pending', 'waiting_approval', 'waiting_user', 'waiting_hand'])(
    'defers while legacy run is %s and succeeds after completion',
    async (status) => {
      const p = await pair();
      await pool.query(`INSERT INTO ${prefix}_runs VALUES ($1, 'kaiyan', $2)`, [
        `old-${p.sessionId}`,
        status,
      ]);
      expect(await store.supersedeLegacyHand(p.newId, 'kaiyan')).toMatchObject({
        outcome: 'blocked',
        reason: 'legacy_work_active',
      });
      await pool.query(`UPDATE ${prefix}_runs SET status = 'completed' WHERE run_id = $1`, [
        `old-${p.sessionId}`,
      ]);
      expect(await store.supersedeLegacyHand(p.newId, 'kaiyan')).toMatchObject({
        outcome: 'superseded',
      });
    },
  );
  it('keeps legacy tool invocation authority even after its run completed', async () => {
    const p = await pair();
    await pool.query(
      `INSERT INTO ${prefix}_tool_invocations VALUES ($1, 'kaiyan', 'running', '{}')`,
      [`old-${p.sessionId}`],
    );
    expect(await store.supersedeLegacyHand(p.newId, 'kaiyan')).toMatchObject({
      reason: 'legacy_work_active',
    });
  });
  it.each(['workspace_id', 'session_id', 'user_id', 'endpoint'])(
    'rejects mismatched %s',
    async (column) => {
      const p = await pair();
      await pool.query(`UPDATE ${prefix}_hands SET ${column} = 'different' WHERE hand_id = $1`, [
        p.legacyId,
      ]);
      expect(await store.supersedeLegacyHand(p.newId, 'kaiyan')).toMatchObject({
        reason: 'environment_identity_mismatch',
      });
    },
  );
  it('rejects scope mismatch, unknown external results and unavailable replacement', async () => {
    const p = await pair();
    await store.updateStatus(p.newId, 'provisioning', {}, 'kaiyan');
    expect(await store.supersedeLegacyHand(p.newId, 'kaiyan')).toMatchObject({
      reason: 'replacement_not_ready',
    });
    await store.updateStatus(p.newId, 'ready', {}, 'kaiyan');
    await store.updateStatus(p.legacyId, 'unhealthy', { reconcileRequired: true }, 'kaiyan');
    expect(await store.supersedeLegacyHand(p.newId, 'kaiyan')).toMatchObject({
      reason: 'legacy_provision_in_flight',
    });
    await store.updateStatus(
      p.legacyId,
      'ready',
      { reconcileRequired: false, recipe: { ...p.input.metadata.recipe, sandboxScopeId: 'other' } },
      'kaiyan',
    );
    expect(await store.supersedeLegacyHand(p.newId, 'kaiyan')).toMatchObject({
      reason: 'environment_identity_mismatch',
    });
  });
  it('automatically retires an old-format session after its new registration finishes provisioning', async () => {
    const sessionId = randomUUID();
    const newId = deriveTenantHandId('kaiyan', sessionId, 'agent-saas-acs');
    const legacyId = `${sessionId}:agent-saas-acs`;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 })),
    );
    try {
      const params = {
        handStore: store,
        eventStore: { append: vi.fn().mockResolvedValue(undefined) } as never,
        executionTransportRegistry: {
          has: () => true,
          get: () => ({ listInternalTools: () => [] }),
        } as never,
        executionTarget: 'server-local' as const,
        sessionId,
        runId: `old-${sessionId}`,
        workspaceId: 'ws_kaiyan__user1',
        workspaceMountSubPath: 'workspaces/kaiyan/user1',
        tenantId: 'kaiyan',
        userTenantId: 'kaiyan',
        userId: 'user1',
        tenantRemoteHands: [
          { id: 'agent-saas-acs', baseUrl: 'https://acs.example', tenantIds: ['kaiyan'] },
        ],
        tenantRemoteHandResolver: {
          resolveForRegister: vi.fn(async () => ({ authToken: 'test', source: 'inline' })),
        } as never,
      };
      await ensureRuntimeHandRegistered(params);
      await vi.waitFor(async () =>
        expect((await store.get(newId, 'kaiyan'))?.status).toBe('ready'),
      );
      // Persist the identity shape written by the old release, retaining recipe and history.
      await pool.query(`UPDATE ${prefix}_hands SET hand_id = $2 WHERE hand_id = $1`, [
        newId,
        legacyId,
      ]);
      await ensureRuntimeHandRegistered({ ...params, runId: `new-${sessionId}` });
      await vi.waitFor(async () =>
        expect((await store.get(legacyId, 'kaiyan'))?.metadata.supersededBy).toBe(newId),
      );
      expect(selectRuntimeHandRoute(await store.listBySession(sessionId, 'kaiyan'))).toMatchObject({
        kind: 'ready',
        handId: newId,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('requires a frozen matching CLI plan, writes a protected snapshot and reads back the result', async () => {
    const p = await pair();
    const dir = await mkdtemp(join(tmpdir(), 'hand-repair-cli-'));
    const config = join(dir, 'config.json');
    const plan = join(dir, 'plan.json');
    const snapshot = join(dir, 'snapshot.jsonl');
    try {
      await writeFile(
        config,
        JSON.stringify({
          runtimeEventStore: { backend: 'pg', connectionString: url, tablePrefix: prefix },
        }),
        { mode: 0o600 },
      );
      const args = [
        '--import',
        'tsx',
        resolve('scripts/repair-legacy-hands.mts'),
        '--config',
        config,
        '--tenant',
        'kaiyan',
        '--plan',
        plan,
      ];
      await promisify(execFile)(process.execPath, [...args, '--session', p.sessionId]);
      expect((await store.get(p.legacyId, 'kaiyan'))?.metadata.supersededBy).toBeUndefined();
      expect(JSON.parse(await readFile(plan, 'utf8')).entries).toHaveLength(1);
      await promisify(execFile)(process.execPath, [...args, '--execute', '--snapshot', snapshot]);
      expect((await stat(snapshot)).mode & 0o777).toBe(0o600);
      expect((await readFile(snapshot, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2);
      expect((await store.get(p.legacyId, 'kaiyan'))?.metadata.supersededBy).toBe(p.newId);
      await expect(
        promisify(execFile)(process.execPath, [
          ...args,
          '--execute',
          '--snapshot',
          join(dir, 'retry.jsonl'),
        ]),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
  it('rejects stale repair snapshots', async () => {
    const p = await pair();
    const old = await store.get(p.legacyId, 'kaiyan');
    const next = await store.get(p.newId, 'kaiyan');
    await pool.query(
      `UPDATE ${prefix}_hands SET updated_at = updated_at + interval '1 second' WHERE hand_id = $1`,
      [p.legacyId],
    );
    expect(
      await supersedeLegacyHand(pool, prefix, p.newId, 'kaiyan', true, {
        legacyUpdatedAt: old!.updatedAt,
        replacementUpdatedAt: next!.updatedAt,
      }),
    ).toMatchObject({ outcome: 'blocked', reason: 'snapshot_changed' });
  });
  it('does not adopt another tenant, even for an identical session ID', async () => {
    const p = await pair();
    expect(await store.supersedeLegacyHand(p.newId, 'other')).toMatchObject({
      reason: 'replacement_identity_mismatch',
    });
    expect((await store.get(p.legacyId, 'kaiyan'))?.metadata.supersededBy).toBeUndefined();
  });
});
