#!/usr/bin/env node
import { execFileSync as defaultExecFileSync } from 'node:child_process';
import { readFileSync as defaultReadFileSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';
import { verifyInstalledRelease } from './verify-installed-release.mjs';
import { validateConfigIdentitySummary } from './read-production-state.mjs';

function requiredString(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function parseReleaseEnvironment(text) {
  const values = {};
  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error('Release environment contains an invalid entry');
    const key = line.slice(0, separator);
    if (Object.hasOwn(values, key)) throw new Error(`Release environment repeats ${key}`);
    values[key] = line.slice(separator + 1);
  }
  return values;
}

export function hasSystemdEnvironment(environment, key, value) {
  const escaped = `${key}=${value}`.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, 'u').test(String(environment));
}

export function validateLiveProductionComponents({
  api,
  web,
  workerReleaseEnvironment,
  workerSystemdEnvironment,
  acs,
}) {
  const apiRelease = api?.release;
  if (
    api?.status !== 'ok' ||
    apiRelease?.environment !== 'production' ||
    apiRelease.safetyAttested !== true
  )
    throw new Error('Production API release identity is not attested');
  if (web?.environment !== 'production' || web?.schemaVersion !== 1)
    throw new Error('Production Web release identity is not attested');
  if (!hasSystemdEnvironment(workerSystemdEnvironment, 'AGENT_SAAS_ENVIRONMENT', 'production'))
    throw new Error('Production Worker environment is not explicit');
  if (
    acs?.environment !== 'production' ||
    acs?.releaseIdentityAttested !== true ||
    acs?.namespace !== 'agent-saas-coding'
  ) {
    throw new Error('Production ACS release identity is not attested');
  }
  const components = {
    web: {
      gitSha: requiredString(web.releaseSha, 'Web source SHA', SHA_PATTERN),
      artifactDigest: requiredString(web.webDigest, 'Web artifact digest', DIGEST_PATTERN),
    },
    api: {
      gitSha: requiredString(apiRelease.releaseSha, 'API source SHA', SHA_PATTERN),
      artifactDigest: requiredString(
        apiRelease.serverDigest,
        'API artifact digest',
        DIGEST_PATTERN,
      ),
    },
    runtimeWorker: {
      gitSha: requiredString(
        workerReleaseEnvironment.AGENT_SAAS_RELEASE_SHA,
        'Worker source SHA',
        SHA_PATTERN,
      ),
      artifactDigest: requiredString(
        workerReleaseEnvironment.AGENT_SAAS_SERVER_DIGEST,
        'Worker artifact digest',
        DIGEST_PATTERN,
      ),
    },
    acs: {
      gitSha: requiredString(acs.sourceSha, 'ACS source SHA', SHA_PATTERN),
      orchestratorArtifactDigest: requiredString(
        acs.orchestratorArtifactDigest,
        'ACS Orchestrator digest',
        DIGEST_PATTERN,
      ),
      sandboxImageDigest: requiredString(
        acs.sandboxImageDigest,
        'ACS Sandbox image digest',
        DIGEST_PATTERN,
      ),
    },
  };
  return components;
}

function activeUnit(role, markerPath, readFileSync, execFileSync) {
  const color = readFileSync(markerPath, 'utf8').trim();
  if (!/^(blue|green)$/u.test(color)) throw new Error(`${role} active color is invalid`);
  const prefix = role === 'api' ? 'agent-saas-server' : 'agent-saas-runtime-worker';
  const unit = `${prefix}@${color}.service`;
  const mainPid = execFileSync('systemctl', ['show', unit, '--property', 'MainPID', '--value'], {
    encoding: 'utf8',
  }).trim();
  const systemdEnvironment = execFileSync(
    'systemctl',
    ['show', unit, '--property', 'Environment', '--value'],
    { encoding: 'utf8' },
  ).trim();
  const pidfile = `/run/${prefix}-${color}.pid`;
  if (!/^[1-9][0-9]*$/u.test(mainPid) || readFileSync(pidfile, 'utf8').trim() !== mainPid)
    throw new Error(`${role} pidfile does not match systemd MainPID`);
  if (role === 'runtimeWorker') {
    const readyfile = `/run/${prefix}-${color}.ready`;
    if (readFileSync(readyfile, 'utf8').trim() !== mainPid)
      throw new Error('Worker readyfile does not match systemd MainPID');
  }
  return { color, unit, systemdEnvironment };
}

export async function readJson(url, { cacheBust = true } = {}) {
  const requestUrl = new URL(url);
  if (cacheBust) requestUrl.searchParams.set('release_observation', String(Date.now()));
  const response = await fetch(requestUrl, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function parse(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    values[key.slice(2)] = value;
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parse(process.argv);
  const apiUnit = activeUnit(
    'api',
    '/etc/agent-saas/active-color',
    defaultReadFileSync,
    defaultExecFileSync,
  );
  const workerUnit = activeUnit(
    'runtimeWorker',
    '/etc/agent-saas/runtime-worker-active-color',
    defaultReadFileSync,
    defaultExecFileSync,
  );
  const workerReleaseEnvironment = {
    ...parseReleaseEnvironment(defaultReadFileSync('/etc/agent-saas/server.env', 'utf8')),
    ...parseReleaseEnvironment(
      defaultReadFileSync(`/etc/agent-saas/runtime-worker-${workerUnit.color}.release.env`, 'utf8'),
    ),
  };
  const [api, web, acs] = await Promise.all([
    readJson(options['api-url'] ?? 'https://api.agent.kaiyan.net/api/healthz/ready'),
    readJson(options['web-url'] ?? 'https://agent.kaiyan.net/release-identity.json'),
    readJson(options['acs-url'] ?? 'http://127.0.0.1:3400/health', { cacheBust: false }),
  ]);
  const apiRoot = realpathSync(`/opt/agent-saas-app/color/${apiUnit.color}`);
  const workerRoot = realpathSync(`/opt/agent-saas-app/worker/${workerUnit.color}`);
  if (apiRoot !== workerRoot)
    throw new Error('Production API and Worker do not execute the same sealed server release');
  const acsRoot = realpathSync('/opt/agent-saas/acs-current');
  const [serverBytes, acsBytes] = await Promise.all([
    verifyInstalledRelease(apiRoot, 'server'),
    verifyInstalledRelease(acsRoot, 'acs'),
  ]);
  const components = validateLiveProductionComponents({
    api,
    web,
    workerReleaseEnvironment,
    workerSystemdEnvironment: workerUnit.systemdEnvironment,
    acs,
  });
  if (
    serverBytes.artifactDigest !== components.api.artifactDigest ||
    serverBytes.artifactDigest !== components.runtimeWorker.artifactDigest ||
    acsBytes.artifactDigest !== components.acs.orchestratorArtifactDigest
  ) {
    throw new Error(
      'Live component identity does not match independently recomputed installed bytes',
    );
  }
  const configIdentity =
    api.configIdentity === undefined
      ? undefined
      : validateConfigIdentitySummary(api.configIdentity);
  const output = {
    schemaVersion: 1,
    environment: 'production',
    observedAt: new Date().toISOString(),
    components,
    // TASK-318：透传经严格白名单重建的只读摘要（旧 API 无字段时向后兼容）。
    ...(configIdentity ? { configIdentity } : {}),
    topology: {
      api: { color: apiUnit.color, unit: apiUnit.unit },
      runtimeWorker: { color: workerUnit.color, unit: workerUnit.unit },
    },
    byteEvidence: {
      apiAndRuntimeWorker: {
        root: apiRoot,
        artifactDigest: serverBytes.artifactDigest,
        contentDigest: serverBytes.contentDigest,
      },
      acs: {
        root: acsRoot,
        artifactDigest: acsBytes.artifactDigest,
        contentDigest: acsBytes.contentDigest,
      },
    },
  };
  if (options.output)
    await writeFile(options.output, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(output)}\n`);
}
