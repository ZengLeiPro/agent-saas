import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { EncryptedFileSecretVault } from '../security/secretVault.js';
import { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { createGrokCredentialPersistence } from '../runtime/responses/grokCredentialPersistence.js';
import { grokSubscriptionTableName } from '../runtime/responses/grokSubscriptionTableNames.js';
import { GrokOAuthClient, type GrokOAuthTokens } from '../runtime/responses/grokOAuthClient.js';
import { grokTokens } from './grokTestFixtures.js';
const connectionString = process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)('Grok independent PostgreSQL consumers (T09-T11)', () => {
  it('refreshes once across independent vaults/managers/pools of size one and shares cooldown fencing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'grok-pg-test-'));
    const prefix = `g${randomUUID().replaceAll('-', '').slice(0, 9)}`;
    const poolA = new pg.Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 2000,
      query_timeout: 3000,
    });
    const poolB = new pg.Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: 2000,
      query_timeout: 3000,
    });
    const vaultA = new EncryptedFileSecretVault(
      join(directory, 'vault.json'),
      'grok-test-encryption-key',
    );
    const vaultB = new EncryptedFileSecretVault(
      join(directory, 'vault.json'),
      'grok-test-encryption-key',
    );
    const config = { enabled: true, credentialRefs: [] as string[], quotaCooldownMinutes: 1 };
    const oauthA = new GrokOAuthClient();
    const oauthB = new GrokOAuthClient();
    const refresh = vi.fn(async (old: GrokOAuthTokens) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return {
        ...old,
        accessToken: 'fixture-access-rotated',
        refreshToken: 'fixture-refresh-rotated',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
    });
    vi.spyOn(oauthA, 'refresh').mockImplementation(refresh);
    vi.spyOn(oauthB, 'refresh').mockImplementation(refresh);
    try {
      const persistenceA = await createGrokCredentialPersistence(poolA, {
        backend: 'pg',
        tablePrefix: prefix,
      });
      const persistenceB = await createGrokCredentialPersistence(poolB, {
        backend: 'pg',
        tablePrefix: prefix,
      });
      const managerA = new GrokCredentialManager({
        vault: vaultA,
        getConfig: () => config,
        oauthClient: oauthA,
        ...persistenceA,
      });
      const managerB = new GrokCredentialManager({
        vault: vaultB,
        getConfig: () => config,
        oauthClient: oauthB,
        ...persistenceB,
      });
      const { credentialRef } = await managerA.persistLogin(grokTokens('shared-account', -1000));
      config.credentialRefs = [credentialRef];
      const [a, b] = await Promise.all([managerA.getCredentials(), managerB.getCredentials()]);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(a.generation).toBe(2);
      expect(b.generation).toBe(2);
      expect(a.accessToken).toBe(b.accessToken);
      expect(await persistenceB.refreshJournal.get(credentialRef)).toBeUndefined();
      await managerA.markQuotaCooldown(credentialRef, 'grok_subscription_quota_exhausted', 2);
      expect(await managerB.getRuntimeState(credentialRef)).toMatchObject({
        availability: 'quota_cooldown',
        credentialGeneration: 2,
      });
      await managerB.markAuthUnavailable(credentialRef, 'invalid_grant', 2);
      await managerA.markQuotaCooldown(credentialRef, 'quota', 2);
      expect(await managerB.getRuntimeState(credentialRef)).toMatchObject({
        availability: 'auth_unavailable',
      });
      await persistenceB.runtimeStateStore.clear(credentialRef, 3);
      await managerA.markAuthUnavailable(credentialRef, 'late-error', 2);
      expect(await managerB.getRuntimeState(credentialRef)).toBeUndefined();
      config.credentialRefs = [];
      await managerB.revoke(credentialRef, false);
      await expect(managerA.getCredentialsForCredential(credentialRef)).rejects.toThrow(
        'subscription_disabled_or_removed',
      );
      expect(poolA.waitingCount).toBe(0);
      expect(poolB.waitingCount).toBe(0);
    } finally {
      // Fresh test-only tables in TEST_DATABASE_URL, never application/production tables.
      for (const kind of ['runtime_state', 'refresh_journal'] as const)
        await poolA
          .query(`DROP TABLE IF EXISTS ${grokSubscriptionTableName(prefix, kind)}`)
          .catch(() => undefined);
      await Promise.all([poolA.end(), poolB.end()]);
      await rm(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  }, 15_000);
});
