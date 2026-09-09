#!/usr/bin/env node
import assert from 'node:assert/strict';
import { publishedExpected } from './config-publication.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { canonicalJson, digestBuffer, DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';
import {
  parseReleaseEnvironment,
  hasSystemdEnvironment,
  readJson,
} from './read-live-production-components.mjs';
import {
  validateConfigIdentitySummary,
  readReleaseConfigIdentityBinding,
} from './read-production-state.mjs';
import { verifyInstalledRelease } from './verify-installed-release.mjs';
import { assertCheckpointManifest } from './production-checkpoint.mjs';

export function assertRepairManifest(manifest) {
  assertCheckpointManifest(manifest);
  assert.equal(manifest.components?.api?.action, 'deploy', 'Repair must replace the App bundle');
  assert.equal(
    manifest.components?.runtimeWorker?.action,
    'deploy',
    'Repair must replace the Runtime Worker',
  );
  assert.equal(
    manifest.migrationPlan?.contract,
    'separate_release',
    'Repair cannot execute contract migrations',
  );
  assert.ok(
    ['none', 'expand'].includes(manifest.migrationPlan?.phase),
    'Repair only supports compatible none/expand migrations',
  );
}

export function validateRecoveryObservations({
  manifest,
  trusted,
  apiEnv,
  workerEnv,
  serverBytes,
  installedManifest,
  acsBytes,
  web,
  acs,
  observedConfig,
  expectedConfig,
}) {
  assertRepairManifest(manifest);
  assertCheckpointManifest(installedManifest);
  assert.equal(trusted?.environment, 'production');
  assert.equal(acs?.status, 'ok', 'Repair requires a healthy existing ACS');
  assert.equal(acs.environment, 'production');
  assert.equal(acs.releaseIdentityAttested, true);
  assert.equal(acs.namespace, 'agent-saas-coding');
  assert.equal(web?.schemaVersion, 1);
  assert.equal(web.environment, 'production');
  for (const env of [apiEnv, workerEnv]) {
    assert.equal(
      env.AGENT_SAAS_SERVER_DIGEST,
      serverBytes.artifactDigest,
      'Installed App bytes differ from the active release binding',
    );
    assert.equal(
      env.AGENT_SAAS_RELEASE_SHA,
      installedManifest.components.api.sourceSha,
      'Installed App source differs from the active release binding',
    );
    assert.equal(
      env.AGENT_SAAS_RELEASE_ID,
      apiEnv.AGENT_SAAS_RELEASE_ID,
      'Active App generations have different release bindings',
    );
  }
  assert.equal(
    apiEnv.AGENT_SAAS_SERVER_DIGEST,
    trusted.components?.api?.artifactDigest,
    'Repair cannot guess an uncommitted App prefix; resume the original promotion first',
  );
  assert.equal(
    workerEnv.AGENT_SAAS_SERVER_DIGEST,
    trusted.components?.runtimeWorker?.artifactDigest,
  );
  assert.equal(apiEnv.AGENT_SAAS_RELEASE_SHA, trusted.components?.api?.gitSha);
  assert.deepEqual(
    expectedConfig,
    trusted.configIdentity,
    'Active release ConfigIdentity differs from the committed identity',
  );
  const configIdentity = validateConfigIdentitySummary({
    schemaVersion: 1,
    status: 'consistent',
    releaseId: apiEnv.AGENT_SAAS_RELEASE_ID,
    expected: expectedConfig,
    observed: observedConfig,
  });
  assert.equal(
    acsBytes.artifactDigest,
    acs.orchestratorArtifactDigest,
    'ACS bytes differ from its live identity',
  );
  const components = {
    api: { gitSha: apiEnv.AGENT_SAAS_RELEASE_SHA, artifactDigest: serverBytes.artifactDigest },
    runtimeWorker: {
      gitSha: workerEnv.AGENT_SAAS_RELEASE_SHA,
      artifactDigest: serverBytes.artifactDigest,
    },
    web: { gitSha: web.releaseSha, artifactDigest: web.webDigest },
    acs: {
      gitSha: acs.sourceSha,
      orchestratorArtifactDigest: acs.orchestratorArtifactDigest,
      sandboxImageDigest: acs.sandboxImageDigest,
    },
  };
  for (const [name, entry] of Object.entries(components)) {
    assert.ok(SHA_PATTERN.test(entry.gitSha ?? ''), `${name} source identity is invalid`);
    for (const [key, value] of Object.entries(entry))
      if (key !== 'gitSha')
        assert.ok(DIGEST_PATTERN.test(value ?? ''), `${name} artifact identity is invalid`);
  }
  return { components, configIdentity };
}

function installedUnit(role) {
  const prefix = role === 'api' ? 'agent-saas-server' : 'agent-saas-runtime-worker';
  const marker =
    role === 'api' ? '/etc/agent-saas/active-color' : '/etc/agent-saas/runtime-worker-active-color';
  const color = readFileSync(marker, 'utf8').trim();
  assert.match(color, /^(blue|green)$/u);
  const unit = `${prefix}@${color}.service`;
  const show = (property) =>
    execFileSync('systemctl', ['show', unit, '--property', property, '--value'], {
      encoding: 'utf8',
    }).trim();
  const path = `/opt/agent-saas-app/${role === 'api' ? 'color' : 'worker'}/${color}`;
  const root = realpathSync(path);
  const environment = show('Environment');
  assert.ok(
    hasSystemdEnvironment(environment, 'AGENT_SAAS_ENVIRONMENT', 'production'),
    'Recovery unit lacks production identity',
  );
  assert.ok(
    hasSystemdEnvironment(
      environment,
      'AGENT_SAAS_PROCESS_ROLE',
      role === 'api' ? 'ws-only' : 'runtime-worker',
    ),
    'Recovery unit has the wrong role',
  );
  assert.equal(
    show('WorkingDirectory'),
    `${path}/server`,
    'Recovery unit working directory differs from the deployed contract',
  );
  const mainPid = show('MainPID');
  if (/^[1-9][0-9]*$/u.test(mainPid)) {
    assert.equal(
      readFileSync(`/run/${prefix}-${color}.pid`, 'utf8').trim(),
      mainPid,
      'Recovery pidfile differs from systemd',
    );
    assert.equal(
      realpathSync(`/proc/${mainPid}/cwd`),
      `${root}/server`,
      'Live process executes an unexpected release',
    );
  } else assert.equal(mainPid, '0', 'Recovery MainPID is invalid');
  const envPath = `/etc/agent-saas/${role === 'api' ? 'server' : 'runtime-worker'}-${color}.release.env`;
  return {
    color,
    unit,
    root,
    envPath,
    env: parseReleaseEnvironment(readFileSync(envPath, 'utf8')),
    mainPid: Number(mainPid),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    assert.ok(
      process.argv[i]?.startsWith('--') && process.argv[i + 1],
      'Every option needs a value',
    );
    options[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  const manifest = JSON.parse(readFileSync(options.manifest, 'utf8'));
  assertRepairManifest(manifest);
  const apiUnit = installedUnit('api');
  const workerUnit = installedUnit('runtimeWorker');
  assert.equal(
    apiUnit.root,
    workerUnit.root,
    'Recovery requires the same sealed App generation for API and Worker',
  );
  const acsRoot = realpathSync('/opt/agent-saas/acs-current');
  const [serverBytes, acsBytes, web, acs, apiBinding, workerBinding] = await Promise.all([
    verifyInstalledRelease(apiUnit.root, 'server'),
    verifyInstalledRelease(acsRoot, 'acs'),
    readJson('https://agent.kaiyan.net/release-identity.json'),
    readJson('http://127.0.0.1:3400/health', { cacheBust: false }),
    readReleaseConfigIdentityBinding(apiUnit.envPath),
    readReleaseConfigIdentityBinding(workerUnit.envPath),
  ]);
  assert.deepEqual(
    apiBinding,
    workerBinding,
    'App and Worker release configuration bindings differ',
  );
  let observedConfig;
  try {
    observedConfig = JSON.parse(
      execFileSync(
        process.execPath,
        [
          `${apiUnit.root}/server/dist/config-identity-cli.js`,
          '--config',
          '/etc/agent-saas/config.json',
          '--environment',
          'production',
          '--process-cwd',
          `${apiUnit.root}/server`,
          '--runtime-data-dir',
          '/mnt/agent-saas/server-data',
          '--env-file',
          '/etc/agent-saas/server.env',
        ],
        { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
  } catch {
    throw new Error('Offline production ConfigIdentity cannot be verified; refusing repair');
  }
  const trusted = JSON.parse(readFileSync('/etc/agent-saas/runtime-identity.json', 'utf8'));
  const selectedExpected = publishedExpected('/etc/agent-saas/config.json', apiUnit.env.AGENT_SAAS_RELEASE_ID, apiBinding.expectedConfigIdentity);
  const selectedTrusted = publishedExpected('/etc/agent-saas/config.json', apiUnit.env.AGENT_SAAS_RELEASE_ID, trusted.configIdentity);
  const verified = validateRecoveryObservations({
    manifest,
    trusted: { ...trusted, configIdentity: selectedTrusted },
    apiEnv: apiUnit.env,
    workerEnv: workerUnit.env,
    serverBytes,
    acsBytes,
    web,
    acs,
    installedManifest: JSON.parse(readFileSync(`${apiUnit.root}/manifest.json`, 'utf8')),
    observedConfig,
    expectedConfig: selectedExpected,
  });
  const body = {
    schemaVersion: 1,
    environment: 'production',
    observedAt: new Date().toISOString(),
    ...verified,
    recovery: {
      mode: 'repair',
      appReadiness: 'not_required_for_old_generation',
      configObservation: 'fresh_offline',
      targetReleaseId: manifest.releaseId,
      targetManifestDigest: manifest.digest,
    },
    topology: {
      api: { color: apiUnit.color, unit: apiUnit.unit },
      runtimeWorker: { color: workerUnit.color, unit: workerUnit.unit },
    },
    byteEvidence: { apiAndRuntimeWorker: serverBytes, acs: acsBytes },
  };
  const output = { ...body, digest: digestBuffer(Buffer.from(canonicalJson(body))) };
  if (options.output)
    await writeFile(options.output, `${canonicalJson(output)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(canonicalJson(output));
}
