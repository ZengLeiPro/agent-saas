import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import test from 'node:test';

import { encryptVault, STAGING_ACS_TOKEN_REF } from './bootstrap-vault.mjs';
import { renderStagingConfig } from './render-config.mjs';

test('renders a fail-closed Staging config while retaining model configuration', () => {
  const source = {
    agent: { cwd: '/production/workspaces', userOverrides: { alice: { extraDirs: ['/prod'] } } },
    auth: {
      enabled: true,
      jwtSecret: 'production-secret',
      selfSignup: { enabled: true, dingtalkLeadWebhook: 'https://example.com' },
    },
    cron: { enabled: true },
    models: { groups: [{ id: 'default', name: 'Default', models: [] }], default: 'default/model' },
    dingtalk: { enabled: true, robots: { prod: { appKey: 'x', appSecret: 'y', name: 'prod' } } },
    webPush: { enabled: true, publicKey: 'x', privateKey: 'y', subject: 'https://example.com' },
  };
  const config = renderStagingConfig(source, {
    STAGING_JWT_SECRET: 'staging-jwt-secret-that-is-at-least-32-characters',
    STAGING_DATABASE_URL: 'postgresql://staging:secret@db.internal/staging',
  });

  assert.deepEqual(config.models, source.models);
  assert.equal(config.cron.enabled, false);
  assert.equal(config.dingtalk.enabled, false);
  assert.equal(config.webPush.enabled, false);
  assert.equal(config.agent.cwd, '/mnt/agent-saas-staging/workspaces');
  assert.deepEqual(config.agent.userOverrides, {});
  assert.equal(config.runtimeScheduler.maxConcurrentRuns, 10);
  assert.equal(config.tenantRemoteHands.hands[0].authTokenRef, STAGING_ACS_TOKEN_REF);
  assert.equal(config.egress.server.failOpen, false);
  assert.deepEqual(config.egress.server.bypassDomains, []);
});

test('bootstraps an EncryptedFileSecretVault-compatible namespaced ACS token', () => {
  const encryptionKey = 'vault-key-that-is-definitely-longer-than-32-characters';
  const acsToken = 'acs-token-that-is-definitely-longer-than-32-characters';
  const envelope = encryptVault({ encryptionKey, acsToken, now: '2026-08-27T00:00:00.000Z' });
  const key = createHash('sha256').update(encryptionKey).digest();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  const vault = JSON.parse(plaintext);

  assert.equal(vault.version, 1);
  assert.equal(vault.secrets[0].id, STAGING_ACS_TOKEN_REF);
  assert.equal(vault.secrets[0].value, acsToken);
  assert.equal(vault.secrets[0].kind, 'tenant_hand');
});
