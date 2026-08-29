#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { canonicalJson, DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';
import { readRuntimeIdentity } from './read-runtime-identity.mjs';

function required(value, label) {
  if (!value || typeof value !== 'object') throw new Error(`${label} is missing`);
  return value;
}

function exactObject(value, allowedKeys, label) {
  const object = required(value, label);
  if (Array.isArray(object)) throw new Error(`${label} must be an object`);
  const unknown = Object.keys(object).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(', ')}`);
  return object;
}

function configIdentitySide(value, label, { observed = false } = {}) {
  const allowed = observed
    ? ['schemaVersion', 'digest', 'credentialVersionDigest', 'versionResolution', 'secretRefCount']
    : ['schemaVersion', 'digest', 'credentialVersionDigest'];
  const side = exactObject(value, allowed, label);
  if (!Number.isSafeInteger(side.schemaVersion) || side.schemaVersion <= 0) {
    throw new Error(`${label}.schemaVersion is invalid`);
  }
  if (!DIGEST_PATTERN.test(side.digest ?? '')) throw new Error(`${label}.digest is invalid`);
  if (
    side.credentialVersionDigest !== undefined &&
    side.credentialVersionDigest !== null &&
    !DIGEST_PATTERN.test(side.credentialVersionDigest)
  ) {
    throw new Error(`${label}.credentialVersionDigest is invalid`);
  }
  if (!observed && side.credentialVersionDigest === null) {
    throw new Error(`${label}.credentialVersionDigest must be omitted rather than null`);
  }
  if (observed) {
    if (!Object.hasOwn(side, 'credentialVersionDigest')) {
      throw new Error(`${label}.credentialVersionDigest is required`);
    }
    if (!['resolved', 'partial', 'unavailable'].includes(side.versionResolution)) {
      throw new Error(`${label}.versionResolution is invalid`);
    }
    if (!Number.isSafeInteger(side.secretRefCount) || side.secretRefCount < 0) {
      throw new Error(`${label}.secretRefCount is invalid`);
    }
  }
  return {
    schemaVersion: side.schemaVersion,
    digest: side.digest,
    ...(side.credentialVersionDigest !== undefined
      ? { credentialVersionDigest: side.credentialVersionDigest }
      : {}),
    ...(observed
      ? {
          versionResolution: side.versionResolution,
          secretRefCount: side.secretRefCount,
        }
      : {}),
  };
}

const CONFIG_IDENTITY_STATUSES = ['consistent', 'drifted', 'unverifiable', 'not_collected'];
const CONFIG_IDENTITY_REASONS = [
  'expected_not_bound',
  'observed_unavailable',
  'secret_ref_version_unresolved',
  'schema_version_unsupported',
];

function assertConfigIdentityRelationship(summary, expected, observed) {
  if (observed) {
    const hasCredentialDigest = observed.credentialVersionDigest != null;
    const invalidResolutionShape =
      (observed.versionResolution === 'resolved' &&
        hasCredentialDigest !== (observed.secretRefCount > 0)) ||
      (observed.versionResolution === 'partial' &&
        (!hasCredentialDigest || observed.secretRefCount === 0)) ||
      (observed.versionResolution === 'unavailable' &&
        (hasCredentialDigest || observed.secretRefCount === 0));
    if (invalidResolutionShape) {
      throw new Error('Production API observed config identity version metadata conflicts');
    }
  }
  if (summary.status === 'unverifiable') {
    const reasonMatches =
      (summary.reason === 'expected_not_bound' && !expected && Boolean(observed)) ||
      (summary.reason === 'observed_unavailable' && !observed) ||
      (summary.reason === 'secret_ref_version_unresolved' &&
        Boolean(observed) &&
        observed?.versionResolution !== 'resolved') ||
      (summary.reason === 'schema_version_unsupported' &&
        Boolean(expected) &&
        Boolean(observed) &&
        (expected?.schemaVersion !== summary.schemaVersion ||
          observed?.schemaVersion !== summary.schemaVersion));
    if (!reasonMatches) {
      throw new Error('Production API unverifiable config identity reason conflicts with its sides');
    }
  }
  if (!['consistent', 'drifted'].includes(summary.status) || !expected || !observed) return;
  if (expected.schemaVersion !== summary.schemaVersion || observed.schemaVersion !== summary.schemaVersion) {
    throw new Error(`Production API ${summary.status} config identity has unsupported side schema`);
  }
  const credentialDiffers =
    expected.credentialVersionDigest !== undefined &&
    expected.credentialVersionDigest !== observed.credentialVersionDigest;
  if (
    summary.status === 'consistent' &&
    (expected.digest !== observed.digest ||
      observed.versionResolution !== 'resolved' ||
      credentialDiffers)
  ) {
    throw new Error('Production API consistent config identity conflicts with its sides');
  }
  if (
    summary.status === 'drifted' &&
    expected.digest === observed.digest &&
    (observed.versionResolution !== 'resolved' || !credentialDiffers)
  ) {
    throw new Error('Production API drifted config identity has no comparable mismatch');
  }
}

export function validateConfigIdentitySummary(value) {
  const summary = exactObject(
    value,
    [
      'schemaVersion',
      'status',
      'reason',
      'expected',
      'observed',
      'releaseId',
      'firstObservedAt',
      'lastObservedAt',
      'lastChangedAt',
    ],
    'Production API config identity',
  );
  if (summary.schemaVersion !== 1 || !CONFIG_IDENTITY_STATUSES.includes(summary.status)) {
    throw new Error('Production API config identity payload is malformed');
  }
  if (summary.reason !== undefined && !CONFIG_IDENTITY_REASONS.includes(summary.reason)) {
    throw new Error('Production API config identity reason is malformed');
  }
  for (const field of ['releaseId', 'firstObservedAt', 'lastObservedAt', 'lastChangedAt']) {
    if (summary[field] !== undefined && (typeof summary[field] !== 'string' || !summary[field])) {
      throw new Error(`Production API config identity ${field} is malformed`);
    }
  }
  if (
    (summary.status === 'consistent' || summary.status === 'drifted') &&
    (!summary.expected || !summary.observed)
  ) {
    throw new Error(
      `Production API ${summary.status} config identity requires expected and observed`,
    );
  }
  if (summary.status === 'unverifiable' && !summary.reason) {
    throw new Error('Production API unverifiable config identity requires reason');
  }
  if (summary.status !== 'unverifiable' && summary.reason) {
    throw new Error('Production API config identity reason is only valid for unverifiable');
  }
  if (summary.status === 'not_collected' && summary.observed) {
    throw new Error('Production API not_collected config identity must not include observed');
  }
  const expected = summary.expected
    ? configIdentitySide(summary.expected, 'configIdentity.expected')
    : undefined;
  const observed = summary.observed
    ? configIdentitySide(summary.observed, 'configIdentity.observed', { observed: true })
    : undefined;
  assertConfigIdentityRelationship(summary, expected, observed);
  return {
    schemaVersion: 1,
    status: summary.status,
    ...(summary.reason ? { reason: summary.reason } : {}),
    ...(expected ? { expected } : {}),
    ...(observed ? { observed } : {}),
    ...(summary.releaseId ? { releaseId: summary.releaseId } : {}),
    ...(summary.firstObservedAt ? { firstObservedAt: summary.firstObservedAt } : {}),
    ...(summary.lastObservedAt ? { lastObservedAt: summary.lastObservedAt } : {}),
    ...(summary.lastChangedAt ? { lastChangedAt: summary.lastChangedAt } : {}),
  };
}

export function validateProductionObservations({ runtime, api, web, acs }) {
  const identity = required(runtime, 'Trusted runtime identity');
  const apiRelease = required(api?.release, 'Production API release identity');
  const webRelease = required(web, 'Production Web release identity');
  const acsRelease = required(acs, 'Production ACS release identity');
  // TASK-318：API 只读脱敏配置身份摘要。严格重建白名单字段，未知字段
  // 直接拒绝，禁止意外 secret/路径进入 Production State 与 Release Evidence。
  const apiConfigIdentity =
    api?.configIdentity === undefined
      ? undefined
      : validateConfigIdentitySummary(api.configIdentity);
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
  if (apiConfigIdentity?.releaseId && apiConfigIdentity.releaseId !== apiRelease.releaseId) {
    throw new Error('Production API config identity releaseId disagrees with API release identity');
  }
  if (identity.configIdentity && apiConfigIdentity?.expected) {
    for (const field of ['schemaVersion', 'digest', 'credentialVersionDigest']) {
      if (
        (identity.configIdentity[field] ?? null) !== (apiConfigIdentity.expected[field] ?? null)
      ) {
        throw new Error(`Production expected config identity ${field} disagrees across observers`);
      }
    }
  }

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
    // TASK-318：结构化配置身份（四态 + 安全摘要）。与上面的 legacy
    // configFingerprints 并存（显式版本化，不改变旧字段语义）。
    ...(apiConfigIdentity ? { configIdentity: apiConfigIdentity } : {}),
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
