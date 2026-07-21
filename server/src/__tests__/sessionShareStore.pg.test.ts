import { createHash, randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { COMPROMISED_LEGACY_SESSION_SHARE_TOKEN_HASHES } from '../data/sessionShares/compromisedTokenHashes.js';
import {
  PgSessionShareStore,
  type SessionShareSnapshot,
  type UpsertSessionShareInput,
} from '../data/sessionShares/store.js';
import {
  workflowDemoPgSuiteEnabled,
  workflowDemoTestPgUrl,
} from './helpers/workflowDemoPgHarness.js';

const { Pool } = pg;
const describePg = workflowDemoPgSuiteEnabled() ? describe : describe.skip;

describePg('Session Share Store PostgreSQL 安全契约', () => {
  const prefix = `ssc_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  let pool: InstanceType<typeof Pool>;
  let store: PgSessionShareStore;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: workflowDemoTestPgUrl()!,
      connectionTimeoutMillis: 5_000,
      max: 24,
    });
    store = new PgSessionShareStore({ pool, tablePrefix: prefix });
    const peer = new PgSessionShareStore({ pool, tablePrefix: prefix });
    await Promise.all([store.init(), peer.init()]);
  }, 30_000);

  afterAll(async () => {
    if (!pool || !store) return;
    try {
      await pool.query(`DROP TABLE IF EXISTS ${store.sharesTable}`);
    } finally {
      await pool.end();
    }
  }, 30_000);

  it('并发更新同一会话始终只有一条活跃分享', async () => {
    const input = shareInput('concurrent-session');
    const records = await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.upsertActive({
        ...input,
        snapshot: snapshot(`concurrent-session-${index}`),
      })),
    );

    expect(new Set(records.map((record) => record.shareId)).size).toBe(1);
    const count = await pool.query<{ active_count: string }>(
      `SELECT count(*) AS active_count
       FROM ${store.sharesTable}
       WHERE session_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL`,
      [input.sessionId, input.ownerUserId],
    );
    expect(Number(count.rows[0]?.active_count)).toBe(1);
  });

  it('兼容读取 N 版本写入的 plaintext token 并幂等补齐 hash', async () => {
    const token = `legacy-${randomUUID().replaceAll('-', '')}`;
    const shareId = randomUUID();
    await insertLegacyRow({
      shareId,
      token,
      sessionId: 'legacy-blue-green-session',
      ownerUserId: 'legacy-blue-green-owner',
    });

    await expect(store.getByToken(token)).resolves.toMatchObject({ shareId, token });
    const result = await pool.query<{ token_hash: string | null }>(
      `SELECT token_hash FROM ${store.sharesTable} WHERE share_id=$1`,
      [shareId],
    );
    expect(result.rows[0]?.token_hash).toBe(sha256(token));
  });

  it('init 回填并撤销命中泄漏 hash 清单的历史 token', async () => {
    expect(COMPROMISED_LEGACY_SESSION_SHARE_TOKEN_HASHES.size).toBe(53);
    const token = `compromised-${randomUUID().replaceAll('-', '')}`;
    const tokenHash = sha256(token);
    const shareId = randomUUID();
    COMPROMISED_LEGACY_SESSION_SHARE_TOKEN_HASHES.add(tokenHash);
    try {
      await insertLegacyRow({
        shareId,
        token,
        sessionId: 'compromised-session',
        ownerUserId: 'compromised-owner',
      });
      await store.init();

      const result = await pool.query<{ token_hash: string | null; revoked_at: Date | null }>(
        `SELECT token_hash,revoked_at FROM ${store.sharesTable} WHERE share_id=$1`,
        [shareId],
      );
      expect(result.rows[0]?.token_hash).toBe(tokenHash);
      expect(result.rows[0]?.revoked_at).toBeInstanceOf(Date);
      await expect(store.getByToken(token)).resolves.toBeNull();
    } finally {
      COMPROMISED_LEGACY_SESSION_SHARE_TOKEN_HASHES.delete(tokenHash);
    }
  });

  async function insertLegacyRow(input: {
    shareId: string;
    token: string;
    sessionId: string;
    ownerUserId: string;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO ${store.sharesTable}
         (share_id,token,token_hash,session_id,tenant_id,owner_user_id,owner_username,
          created_by_user_id,created_at,updated_at,debug_mode,snapshot_json)
       VALUES ($1,$2,NULL,$3,'test-tenant',$4,'tester',$4,now(),now(),false,$5::jsonb)`,
      [input.shareId, input.token, input.sessionId, input.ownerUserId, JSON.stringify(snapshot(input.sessionId))],
    );
  }
});

function shareInput(sessionId: string): UpsertSessionShareInput {
  return {
    sessionId,
    tenantId: 'test-tenant',
    ownerUserId: 'test-owner',
    ownerUsername: 'tester',
    createdByUserId: 'test-owner',
    debugMode: false,
    snapshot: snapshot(sessionId),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
  };
}

function snapshot(sessionId: string): SessionShareSnapshot {
  return {
    sessionId,
    stats: { lines: 0, parsedLines: 0, parseErrors: 0 },
    blocks: [],
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
