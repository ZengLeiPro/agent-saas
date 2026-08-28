#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { canonicalJson, DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';
import { readRuntimeIdentity } from './read-runtime-identity.mjs';

function required(value, label) {
  if (!value || typeof value !== 'object') throw new Error(`${label} is missing`);
  return value;
}

export function validateProductionObservations({ runtime, api, web, acs }) {
  const identity = required(runtime, 'Trusted runtime identity');
  const apiRelease = required(api?.release, 'Production API release identity');
  const webRelease = required(web, 'Production Web release identity');
  const acsRelease = required(acs, 'Production ACS release identity');
  if (
    identity.environment !== 'production' ||
    apiRelease.environment !== 'production' ||
    webRelease.environment !== 'production' ||
    acsRelease.environment !== 'production'
  ) {
    throw new Error('Every production observation must explicitly identify production');
  }
  if (api?.status !== 'ok' || apiRelease.safetyAttested !== true)
    throw new Error('Production API is not ready with an attested identity');
  if (webRelease.schemaVersion !== 1 || acsRelease.releaseIdentityAttested !== true)
    throw new Error('Production Web or ACS identity is not attested');
  if (acsRelease.namespace !== 'agent-saas-coding')
    throw new Error('Production ACS namespace is not authoritative');

  const components = identity.components;
  if (!components) throw new Error('Trusted production component matrix is missing');
  const assertions = [
    [apiRelease.releaseSha, components.api.gitSha, 'API source SHA'],
    [apiRelease.serverDigest, components.api.artifactDigest, 'API artifact digest'],
    [webRelease.releaseSha, components.web.gitSha, 'Web source SHA'],
    [webRelease.webDigest, components.web.artifactDigest, 'Web artifact digest'],
    [acsRelease.sourceSha, components.acs.gitSha, 'ACS source SHA'],
    [
      acsRelease.orchestratorArtifactDigest,
      components.acs.orchestratorArtifactDigest,
      'ACS Orchestrator digest',
    ],
    [acsRelease.sandboxImageDigest, components.acs.sandboxImageDigest, 'ACS image digest'],
  ];
  for (const [observed, expected, label] of assertions) {
    if (observed !== expected) throw new Error(`${label} disagrees across production observers`);
  }
  for (const [component, value] of Object.entries(components)) {
    if (!SHA_PATTERN.test(value.gitSha ?? ''))
      throw new Error(`${component} source SHA is unknown`);
    const digests =
      component === 'acs'
        ? [value.orchestratorArtifactDigest, value.sandboxImageDigest]
        : [value.artifactDigest];
    if (digests.some((digest) => !DIGEST_PATTERN.test(digest ?? '')))
      throw new Error(`${component} artifact identity is unknown`);
  }
  if (
    components.api.gitSha !== components.runtimeWorker.gitSha ||
    components.api.artifactDigest !== components.runtimeWorker.artifactDigest
  ) {
    throw new Error('Production API and Worker do not share the same Server bundle');
  }
  const body = {
    schemaVersion: 1,
    environment: 'production',
    observedAt: identity.topology.observedAt,
    releaseId: apiRelease.releaseId,
    components,
    configFingerprints: {
      runtime: identity.configFingerprint,
      acs: acsRelease.configFingerprint,
      web: webRelease.configFingerprint,
    },
    topology: identity.topology,
  };
  return {
    ...body,
    digest: `sha256:${createHash('sha256').update(canonicalJson(body)).digest('hex')}`,
  };
}

export function productionObservationUrl(url, now = Date.now()) {
  const requestUrl = new URL(url);
  if (!['127.0.0.1', '::1', 'localhost'].includes(requestUrl.hostname))
    requestUrl.searchParams.set('release_observation', String(now));
  return requestUrl;
}

async function json(url) {
  const requestUrl = productionObservationUrl(url);
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
  const runtime = readRuntimeIdentity({
    identityPath: '/etc/agent-saas/runtime-identity.json',
    refreshTopologyObservation: true,
  });
  if (!runtime.ok) throw new Error(runtime.blockingReasons.join(' '));
  const [api, web, acs] = await Promise.all([
    json(options['api-url'] ?? 'https://api.agent.kaiyan.net/api/healthz/ready'),
    json(options['web-url'] ?? 'https://agent.kaiyan.net/release-identity.json'),
    json(options['acs-url'] ?? 'http://127.0.0.1:3400/health'),
  ]);
  const state = validateProductionObservations({ runtime: runtime.identity, api, web, acs });
  if (options.output)
    await writeFile(options.output, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(state)}\n`);
}
