/**
 * WP2a 其余四个 store 的 PostgreSQL 合约：签名密钥、握手 nonce、出站事件、
 * 运行状态与凭据/安装密钥。系统目录三表另见 `systems/store.pg.test.ts`。
 */
import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { governanceV41KyAppSystemStatements } from '../../data/governance-schema/v41KyAppSystemMigration.js';
import { InMemoryKyAppNonceStore, PgKyAppNonceStore } from '../attest/nonceStore.js';
import { PgKyAppOutboundEventStore } from '../events/store.js';
import {
  PgKyAppCredentialStore,
  serviceCredentialDigest,
} from '../installations/credentialStore.js';
import { PgKyAppInstallationRuntimeStore } from '../installations/runtimeStore.js';
import { PgKyAppSigningKeyStore } from '../keys/store.js';

const testPgUrl = process.env.TEST_DATABASE_URL?.trim();
const describePg = testPgUrl ? describe : describe.skip;
const { Pool } = pg;

const DAY_MS = 24 * 60 * 60 * 1000;

function jwk(kid: string): Record<string, unknown> {
  return { kty: 'EC', crv: 'P-256', use: 'sig', kid, x: 'x-coordinate', y: 'y-coordinate' };
}

describePg('定制项目密钥 / nonce / 事件 / 运行状态 / 凭据 PostgreSQL 合约', () => {
  const prefix = `ky_app_misc_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  let pool: InstanceType<typeof Pool>;
  let keys: PgKyAppSigningKeyStore;
  let nonces: PgKyAppNonceStore;
  let events: PgKyAppOutboundEventStore;
  let runtime: PgKyAppInstallationRuntimeStore;
  let credentials: PgKyAppCredentialStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: testPgUrl!, connectionTimeoutMillis: 5_000, max: 4 });
    await pool.query(`CREATE TABLE IF NOT EXISTS ${prefix}_resource_assignments (
      assignment_id TEXT PRIMARY KEY,
      resource_type TEXT NOT NULL
    )`);
    for (const statement of governanceV41KyAppSystemStatements(prefix)) await pool.query(statement);
    keys = new PgKyAppSigningKeyStore({ pool, tablePrefix: prefix });
    nonces = new PgKyAppNonceStore({ pool, tablePrefix: prefix });
    events = new PgKyAppOutboundEventStore({ pool, tablePrefix: prefix });
    runtime = new PgKyAppInstallationRuntimeStore({ pool, tablePrefix: prefix });
    credentials = new PgKyAppCredentialStore({ pool, tablePrefix: prefix });
  }, 30_000);

  afterAll(async () => {
    if (!pool) return;
    for (const table of [
      `${prefix}_ky_app_tenant_system_installations`,
      `${prefix}_ky_app_system_definition_versions`,
      `${prefix}_ky_app_system_definitions`,
      `${prefix}_ky_app_signing_keys`,
      `${prefix}_ky_app_handshake_nonces`,
      `${prefix}_ky_app_outbound_events`,
      `${prefix}_ky_app_installation_runtime`,
      `${prefix}_ky_app_service_credentials`,
      `${prefix}_ky_app_installation_keys`,
      `${prefix}_resource_assignments`,
    ]) {
      await pool.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    await pool.end();
  });

  it('签名密钥：active/next 各唯一，promote 让旧键 retiring，revoke 与到期下线立即移出 JWKS', async () => {
    await keys.insert({
      kid: 'k-2026-09',
      publicJwk: jwk('k-2026-09'),
      secretRef: 'ref-1',
      status: 'active',
    });
    await expect(
      keys.insert({ kid: 'k-dup', publicJwk: jwk('k-dup'), secretRef: 'ref-x', status: 'active' }),
    ).rejects.toThrow();
    await keys.insert({
      kid: 'k-2026-10',
      publicJwk: jwk('k-2026-10'),
      secretRef: 'ref-2',
      status: 'next',
    });
    expect((await keys.listPublishable()).map((key) => key.kid)).toEqual([
      'k-2026-09',
      'k-2026-10',
    ]);

    const promoted = await keys.promote('k-2026-10', DAY_MS);
    expect(promoted.status).toBe('active');
    expect((await keys.get('k-2026-09'))?.status).toBe('retiring');
    await expect(keys.promote('k-2026-09', DAY_MS)).rejects.toThrow(/只有 next/u);

    // 24 小时未到不下线，过了就转 revoked 并退出 JWKS。
    expect(await keys.retireExpired(new Date(Date.now() + 60_000))).toEqual([]);
    expect(await keys.retireExpired(new Date(Date.now() + DAY_MS + 60_000))).toEqual(['k-2026-09']);
    expect((await keys.listPublishable()).map((key) => key.kid)).toEqual(['k-2026-10']);

    await keys.revoke('k-2026-10');
    expect(await keys.listPublishable()).toEqual([]);
  }, 30_000);

  it('nonce 跨进程原子消费：并发只有一次成功，PG 与内存实现语义一致', async () => {
    const now = new Date();
    const binding = {
      nonce: `n-${randomUUID().replaceAll('-', '')}`,
      installationId: 'tsi_01',
      tenantId: 't_demo',
      userId: 'u_1',
      sessionId: 'sess_1',
      expiresAt: new Date(now.getTime() + 60_000),
    };
    await nonces.issue(binding);
    const results = await Promise.all([
      nonces.consume(binding.nonce, now),
      nonces.consume(binding.nonce, now),
      nonces.consume(binding.nonce, now),
    ]);
    expect(results.filter((item) => item !== null)).toHaveLength(1);

    const memory = new InMemoryKyAppNonceStore();
    await memory.issue(binding);
    expect(await memory.consume(binding.nonce, now)).not.toBeNull();
    expect(await memory.consume(binding.nonce, now)).toBeNull();

    const expired = {
      ...binding,
      nonce: `n-${randomUUID().replaceAll('-', '')}`,
      expiresAt: new Date(now.getTime() - 1),
    };
    await nonces.issue(expired);
    expect(await nonces.consume(expired.nonce, now)).toBeNull();
    expect(await nonces.purgeExpired(now)).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('事件 outbox：同 stateVersion 幂等入队、按序取待发、失败退避、超窗口 abandoned', async () => {
    const now = new Date();
    const first = await events.enqueue({
      installationId: 'tsi_01',
      stateVersion: 2,
      type: 'installation.enabled',
      retryWindowMs: DAY_MS,
      now,
    });
    const duplicate = await events.enqueue({
      installationId: 'tsi_01',
      stateVersion: 2,
      type: 'installation.enabled',
      retryWindowMs: DAY_MS,
      now,
    });
    expect(duplicate.eventId).toBe(first.eventId);

    await events.enqueue({
      installationId: 'tsi_01',
      stateVersion: 3,
      type: 'installation.disabled',
      retryWindowMs: DAY_MS,
      now,
    });
    const due = await events.listDue(new Date(now.getTime() + 1000));
    expect(due.map((event) => event.stateVersion)).toEqual([2, 3]);
    expect((await events.listSince('tsi_01', 3)).map((event) => event.stateVersion)).toEqual([3]);

    const failed = await events.markFailed({
      eventId: first.eventId,
      error: 'connect ECONNREFUSED',
      now,
    });
    expect(failed?.status).toBe('pending');
    expect(failed?.attempts).toBe(1);
    expect(new Date(failed!.nextAttemptAt).getTime()).toBeGreaterThan(now.getTime());

    const exhausted = await events.markFailed({
      eventId: first.eventId,
      error: '仍然不可达',
      now: new Date(now.getTime() + DAY_MS),
    });
    expect(exhausted?.status).toBe('abandoned');
    expect(await events.markDelivered(first.eventId)).toBeNull();

    const delivered = await events.markDelivered(due[1]!.eventId, 'k-2026-10');
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.verifiedKid).toBe('k-2026-10');
  }, 30_000);

  it('运行状态：live 失败累计、成功清零，ready 写 digest 与 jwksKids', async () => {
    await runtime.recordLive({ installationId: 'tsi_02', status: 'failed', error: 'timeout' });
    const second = await runtime.recordLive({
      installationId: 'tsi_02',
      status: 'failed',
      error: 'timeout',
    });
    expect(second.consecutiveFailures).toBe(2);
    const recovered = await runtime.recordLive({ installationId: 'tsi_02', status: 'ok' });
    expect(recovered.consecutiveFailures).toBe(0);
    expect(recovered.liveStatus).toBe('ok');

    const ready = await runtime.recordReady({
      installationId: 'tsi_02',
      status: 'ok',
      manifestDigest: 'a'.repeat(64),
      contractVersion: 1,
      appVersion: '1.2.3',
      jwksKids: ['k-2026-10'],
      directoryAgeSeconds: 12,
    });
    expect(ready).toMatchObject({
      readyStatus: 'ok',
      manifestDigest: 'a'.repeat(64),
      contractVersion: 1,
      jwksKids: ['k-2026-10'],
      directoryAgeSeconds: 12,
    });
    await runtime.markAlerted('tsi_02');
    expect((await runtime.get('tsi_02'))?.alertedAt).not.toBeNull();
  }, 30_000);

  it('凭据：只存 sha256、一次性领取、24 小时 ack 窗口、安装密钥 current/previous 轮换', async () => {
    const now = new Date();
    const token = `svc-${randomUUID()}`;
    const record = await credentials.issueCredential({
      credentialId: 'cred-1',
      installationId: 'tsi_03',
      tokenSha256: serviceCredentialDigest(token),
      scopes: ['snapshot', 'changes', 'credential-ack'],
      secretRef: 'vault-ref-1',
      ackDeadlineAt: new Date(now.getTime() + DAY_MS),
      expiresAt: new Date(now.getTime() + 90 * DAY_MS),
    });
    expect(record.status).toBe('pending_ack');
    expect(record.tokenSha256).not.toContain(token);
    expect((await credentials.findByToken(token))?.credentialId).toBe('cred-1');
    expect(await credentials.findByToken('wrong-token')).toBeNull();

    expect(await credentials.markClaimed('cred-1')).not.toBeNull();
    expect(await credentials.markClaimed('cred-1')).toBeNull();
    expect(
      await credentials.acknowledge('cred-1', new Date(now.getTime() + 2 * DAY_MS)),
    ).toBeNull();
    expect((await credentials.acknowledge('cred-1', now))?.status).toBe('active');
    expect((await credentials.revokeCredential('cred-1'))?.status).toBe('revoked');

    const current = await credentials.rotateInstallationKey({
      installationId: 'tsi_03',
      keyVersion: 'v1',
      secretRef: 'vault-key-1',
      acceptPreviousMs: DAY_MS,
    });
    expect(current.status).toBe('current');
    await expect(
      credentials.rotateInstallationKey({
        installationId: 'tsi_03',
        keyVersion: 'v1',
        secretRef: 'vault-key-1',
        acceptPreviousMs: DAY_MS,
      }),
    ).rejects.toThrow(/keyVersion 已存在/u);

    await credentials.rotateInstallationKey({
      installationId: 'tsi_03',
      keyVersion: 'v2',
      secretRef: 'vault-key-2',
      acceptPreviousMs: DAY_MS,
    });
    expect((await credentials.findAcceptableKey('tsi_03', 'v2', now))?.status).toBe('current');
    expect((await credentials.findAcceptableKey('tsi_03', 'v1', now))?.status).toBe('previous');
    expect(
      await credentials.findAcceptableKey(
        'tsi_03',
        'v1',
        new Date(now.getTime() + DAY_MS + 60_000),
      ),
    ).toBeNull();
  }, 30_000);
});
