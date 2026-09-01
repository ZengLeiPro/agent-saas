import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import test from 'node:test';

import { encryptVault, STAGING_ACS_TOKEN_REF } from './bootstrap-vault.mjs';
import { renderStagingConfig } from './render-config.mjs';

test('renders a fail-closed Staging config with persistent local Artifact storage', () => {
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
    tts: { doubaoAppId: 'prod-app', doubaoApiKey: 'prod-key' },
    stt: {
      enabled: true,
      apiKeyRef: 'production/stt-api',
      ossAccessKeyIdRef: 'production/stt-oss-id',
      ossAccessKeySecretRef: 'production/stt-oss-secret',
    },
    memory: {
      enabled: true,
      polling: { enabled: true },
      consolidation: { enabled: true },
      index: {
        enabled: true,
        embedding: {
          baseUrl: 'https://prod.example.com',
          apiKey: 'prod',
          model: 'x',
          dimensions: 1,
        },
      },
    },
    dispatch: { enabled: true, env: { ARK_API_KEY: 'production-key' } },
    systemMonitor: { enabled: true, tlsCheckHosts: ['agent.kaiyan.net'] },
    runtimeEventRetention: { enabled: true, executionMode: 'execute' },
    integrationV3ControlPlane: { enabled: true, githubTokenMode: 'production' },
  };
  const config = renderStagingConfig(source, {
    STAGING_JWT_SECRET: 'staging-jwt-secret-that-is-at-least-32-characters',
    STAGING_ARTIFACT_SIGNED_URL_SECRET: 'staging-artifact-secret-that-is-at-least-32-characters',
    STAGING_DATABASE_URL: 'postgresql://staging:secret@db.internal/staging',
    STAGING_CAPABILITY_CONFIG_JSON: JSON.stringify({
      models: source.models,
      cron: { enabled: true },
      dingtalk: { enabled: true, robots: { test: { appKey: 'staging-app', appSecret: 'staging-secret', name: 'test' } } },
      webPush: { enabled: true, publicKey: 'staging-public', privateKey: 'staging-private', subject: 'https://staging-agent.kaiyan.net' },
      codexSubscription: { enabled: true, websocketEnabled: true, credentialRef: 'STAGING_AGENT_SAAS/codex' },
      webTools: { enabled: true, search: { provider: 'brave', apiKeyRef: 'STAGING_AGENT_SAAS/web-search' } },
      imageGenTools: { enabled: true, gptImage2: { enabled: true, apiKeyRef: 'STAGING_AGENT_SAAS/image-gen', baseUrl: 'https://api.openai.com/v1' } },
      stt: { enabled: true, apiKeyRef: 'STAGING_AGENT_SAAS/stt', ossAccessKeyIdRef: 'STAGING_AGENT_SAAS/oss-id', ossAccessKeySecretRef: 'STAGING_AGENT_SAAS/oss-secret' },
      memory: { enabled: true, polling: { enabled: true }, consolidation: { enabled: true } },
      systemMonitor: { enabled: true, tlsCheckHosts: ['staging-agent.kaiyan.net'] },
      runtimeEventRetention: { enabled: true, executionMode: 'execute' },
      integrationV3ControlPlane: { enabled: true, githubTokenMode: 'staging' },
    }),
  });

  assert.deepEqual(config.models, source.models);
  assert.equal(config.cron.enabled, true);
  assert.equal(config.cron.store, '/mnt/agent-saas-staging/runtime/server/data/cron-jobs.json');
  assert.equal(config.dingtalk.enabled, true);
  assert.equal(config.dingtalk.robots.test.appKey, 'staging-app');
  assert.equal(config.webPush.enabled, true);
  assert.equal(config.agent.cwd, '/mnt/agent-saas-staging/workspaces');
  assert.equal(config.agent.sharedDir, '/opt/agent-saas-staging/current/server/workspace-shared');
  assert.deepEqual(config.agent.userOverrides, {});
  assert.deepEqual(config.artifact, {
    backend: 'local',
    rootDir: '/mnt/agent-saas-staging/runtime/artifacts',
    signedUrlSecret: 'staging-artifact-secret-that-is-at-least-32-characters',
    readUrlTtlSeconds: 900,
    maxBlobBytes: 100 * 1024 * 1024,
    retentionDays: 90,
    gcIntervalMs: 24 * 60 * 60 * 1000,
  });
  assert.notEqual(config.artifact.signedUrlSecret, config.auth.jwtSecret);
  assert.equal(config.runtimeScheduler.maxConcurrentRuns, 10);
  assert.equal(config.tenantRemoteHands.hands[0].authTokenRef, STAGING_ACS_TOKEN_REF);
  assert.equal(config.egress.server.failOpen, false);
  assert.deepEqual(config.egress.server.bypassDomains, []);
  assert.equal(config.codexSubscription.enabled, true);
  assert.equal(config.webTools.enabled, true);
  assert.equal(config.imageGenTools.enabled, true);
  assert.equal(config.stt.enabled, true);
  assert.equal(config.memory.enabled, true);
  assert.deepEqual(config.dispatch, { enabled: true, env: {} });
  assert.equal(config.systemMonitor.enabled, true);
  assert.equal(config.runtimeEventRetention.enabled, true);
  assert.equal(config.integrationV3ControlPlane.githubTokenMode, 'staging');
});

test('rejects a Staging Artifact signing secret reused from auth', () => {
  const sharedSecret = 'shared-secret-that-is-at-least-32-characters';
  assert.throws(
    () => renderStagingConfig({}, {
      STAGING_JWT_SECRET: sharedSecret,
      STAGING_ARTIFACT_SIGNED_URL_SECRET: sharedSecret,
      STAGING_DATABASE_URL: 'postgresql://staging:secret@db.internal/staging',
      STAGING_CAPABILITY_CONFIG_JSON: JSON.stringify({ models: { groups: [], default: 'missing/model' } }),
    }),
    /must be independent/u,
  );
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
