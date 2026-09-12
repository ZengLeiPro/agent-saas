import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const deploy = readFileSync(new URL('./deploy-staging-release.sh', import.meta.url), 'utf8');
const marker = 'node - "$server_config" <<\'NODE\'\n';
const start = deploy.indexOf(marker);
assert.ok(start >= 0);
const body = deploy.slice(start + marker.length, deploy.indexOf('\nNODE', start));
function config() {
  return {
    models: {
      groups: [{ id: 'mixed', responses_transport: 'codex_subscription', models: [{ id: 'a' }] }],
    },
    artifact: {
      backend: 'local',
      rootDir: '/mnt/agent-saas-staging/runtime/artifacts',
      signedUrlSecret: 'fixture-artifact-key',
      readUrlTtlSeconds: 300,
      maxBlobBytes: 104857600,
      retentionDays: 90,
      gcIntervalMs: 86400000,
    },
    auth: { jwtSecret: 'fixture-independent-jwt' },
    dispatch: { env: {} },
  };
}
function validate(value) {
  return vm.runInNewContext(
    body,
    {
      require: (name) => {
        assert.equal(name, 'node:fs');
        return { readFileSync: () => JSON.stringify(value) };
      },
      process: { argv: ['node', '-', 'fixture.json'] },
    },
    { timeout: 1000 },
  );
}
test('actual embedded staging validator accepts Codex and Grok without fake API keys', () => {
  for (const transport of ['codex_subscription', 'grok_subscription']) {
    const value = config();
    value.models.groups[0].responses_transport = transport;
    value[transport === 'codex_subscription' ? 'codexSubscription' : 'grokSubscription'] = {
      enabled: true,
      credentialRefs: ['fixture-ref'],
    };
    assert.doesNotThrow(() => validate(value));
  }
});
test('mixed groups require an API Key reference for each effective API-key model', () => {
  const value = config();
  value.models.groups[0].models.push({ id: 'paid', responses_transport: 'openai_compatible' });
  assert.throws(() => validate(value), /apiKeyRef is required/);
  value.models.groups[0].apiKeyRef = 'fixture-managed-key';
  assert.doesNotThrow(() => validate(value));
  delete value.models.groups[0].apiKeyRef;
  value.models.groups[0].responses_transport = 'openai_compatible';
  value.models.groups[0].models = [{ id: 'grok', responses_transport: 'grok_subscription' }];
  assert.doesNotThrow(() => validate(value));
  value.models.groups[0].models.push({ id: 'inherited-api' });
  assert.throws(() => validate(value), /apiKeyRef is required/);
});
test('enabled subscriptions without references and inline keys remain rejected', () => {
  for (const root of ['codexSubscription', 'grokSubscription']) {
    const value = config();
    value[root] = { enabled: true };
    assert.throws(() => validate(value), /requires a Staging credentialRef/);
  }
  const value = config();
  value.models.groups[0].apiKey = 'fixture-inline';
  assert.throws(() => validate(value), /must use a Staging SecretRef/);
});
test('transport changes preserve independent artifact and dispatch safety gates', () => {
  const value = config();
  value.dispatch.env = { OPENAI_API_KEY: 'fixture-inline' };
  assert.throws(() => validate(value), /dispatch.env must be empty/);
  value.dispatch.env = {};
  value.artifact.signedUrlSecret = value.auth.jwtSecret;
  assert.throws(() => validate(value), /must be independent/);
});
