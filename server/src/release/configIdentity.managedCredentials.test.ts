import { describe, expect, it } from 'vitest';

import { parseAppConfig, type AppConfig } from '../app/config.js';
import { InMemorySecretVault, type VaultCaller } from '../security/secretVault.js';
import {
  assertProductionManagedCredentialSafety,
  buildCanonicalConfigProjection,
  computeObservedConfigIdentity,
  secretRefIdentity,
} from './configIdentity.js';

const SYSTEM_CALLER: VaultCaller = {
  actor: 'system',
  userId: '__system__',
  scopes: ['secret:tenant-hand:write', 'secret:tenant-hand:read', 'secret:tenant-hand:rotate'],
};
const ROTATE_CALLER: VaultCaller = {
  actor: 'system',
  userId: '__system__',
  scopes: ['secret:tenant-hand:read', 'secret:tenant-hand:rotate'],
};
const REVOKE_CALLER: VaultCaller = {
  actor: 'connector_proxy',
  scopes: ['secret:tenant-hand:revoke'],
};

function baseConfig(overrides: Record<string, unknown>): AppConfig {
  return parseAppConfig({
    agent: { cwd: '/srv/agent', permissionMode: 'default' },
    server: { port: 3001, timezone: 'Asia/Shanghai' },
    ...overrides,
  });
}

const MANAGED_API_KEY_CASES = [
  {
    label: 'memory embedding',
    inlinePath: 'memory.index.embedding.apiKey',
    refPath: 'memory.index.embedding.apiKeyRef',
    configWithCredential: (credential: { apiKey?: string; apiKeyRef?: string }) =>
      baseConfig({
        memory: {
          index: {
            embedding: {
              baseUrl: 'https://embedding.example.com',
              model: 'embedding-model',
              dimensions: 8,
              ...credential,
            },
          },
        },
      }),
  },
  {
    label: 'model group',
    inlinePath: 'models.groups[0].apiKey',
    refPath: 'models.groups.*.apiKeyRef',
    configWithCredential: (credential: { apiKey?: string; apiKeyRef?: string }) =>
      baseConfig({
        models: {
          groups: [
            {
              id: 'primary',
              name: 'Primary',
              models: [{ id: 'model-a', name: 'Model A', value: 'model-a' }],
              ...credential,
            },
          ],
          default: 'primary/model-a',
        },
      }),
  },
] as const;

describe.each(MANAGED_API_KEY_CASES)(
  '新增受管凭据注册：$label',
  ({ inlinePath, refPath, configWithCredential }) => {
    it('Production inline apiKey fail closed', () => {
      expect(() =>
        assertProductionManagedCredentialSafety(
          configWithCredential({ apiKey: 'inline-api-key-must-not-run-in-production' }),
        ),
      ).toThrow(`${inlinePath} must use SecretVault ref (apiKeyRef) in production`);
    });

    it('ref identity 进入投影且 ref id 不泄漏', () => {
      const refId = 'tenant-hand/ref-id-must-not-appear';
      const config = configWithCredential({ apiKeyRef: refId });
      const { projection, managedRefs } = buildCanonicalConfigProjection(config);
      const serialized = JSON.stringify(projection);

      expect(managedRefs).toEqual([{ path: refPath, refId, refDigest: secretRefIdentity(refId) }]);
      expect(serialized).not.toContain(refId);
      expect(serialized).toContain(secretRefIdentity(refId).slice(7, 31));
    });

    it('opaque version 的 rotate 改变版本摘要，revoke 后不可验证', async () => {
      const vault = new InMemorySecretVault();
      const ref = await vault.putSecret('global', 'tenant-hand', 'v1-value', SYSTEM_CALLER);
      const config = configWithCredential({ apiKeyRef: ref.id });
      const before = await computeObservedConfigIdentity(config, vault);

      expect(before.versionResolution).toBe('resolved');
      expect(before.secretRefCount).toBe(1);
      expect(before.credentialVersionDigest).not.toBeNull();

      await vault.rotateSecret(ref.id, 'v2-value', ROTATE_CALLER);
      const rotated = await computeObservedConfigIdentity(config, vault);
      expect(rotated.digest).toBe(before.digest);
      expect(rotated.credentialVersionDigest).not.toBe(before.credentialVersionDigest);

      await vault.revokeSecret(ref.id, REVOKE_CALLER);
      const revoked = await computeObservedConfigIdentity(config, vault);
      expect(revoked.digest).toBe(before.digest);
      expect(revoked.versionResolution).toBe('unavailable');
      expect(revoked.credentialVersionDigest).toBeNull();
      expect(revoked.unresolvedRefPaths).toEqual([refPath]);
    });

    it('ref 缺失或 vault 无版本检查能力时均不可验证', async () => {
      const vault = new InMemorySecretVault();
      const missing = await computeObservedConfigIdentity(
        configWithCredential({ apiKeyRef: 'missing-vault-ref' }),
        vault,
      );
      const unverifiable = await computeObservedConfigIdentity(
        configWithCredential({ apiKeyRef: 'unverifiable-vault-ref' }),
        undefined,
      );

      for (const observation of [missing, unverifiable]) {
        expect(observation.versionResolution).toBe('unavailable');
        expect(observation.credentialVersionDigest).toBeNull();
        expect(observation.unresolvedRefPaths).toEqual([refPath]);
      }
    });
  },
);
