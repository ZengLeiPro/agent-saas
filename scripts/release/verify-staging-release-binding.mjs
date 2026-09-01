import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const SHA_PATTERN = /^[a-f0-9]{40}$/u;

function required(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} does not match the immutable Manifest`);
}

export function verifyStagingReleaseBinding({
  manifest,
  webIdentity,
  apiReady,
  acsHealth,
  expectedManifestDigest,
}) {
  const releaseId = required(manifest?.releaseId, 'Manifest release ID', /^rc-\d{8}-\d{2,}$/u);
  const releaseSha = required(manifest?.releaseSha, 'Manifest release SHA', SHA_PATTERN);
  const manifestDigest = required(manifest?.digest, 'Manifest digest', DIGEST_PATTERN);
  if (expectedManifestDigest !== undefined)
    equal(manifestDigest, expectedManifestDigest, 'Manifest digest');

  const apiSourceSha = required(
    manifest?.components?.api?.sourceSha,
    'Manifest API source SHA',
    SHA_PATTERN,
  );
  const webSourceSha = required(
    manifest?.components?.web?.sourceSha,
    'Manifest Web source SHA',
    SHA_PATTERN,
  );
  const acsSourceSha = required(
    manifest?.components?.acs?.sourceSha,
    'Manifest ACS source SHA',
    SHA_PATTERN,
  );
  const serverDigest = required(
    manifest?.components?.api?.artifactDigest,
    'Manifest API digest',
    DIGEST_PATTERN,
  );
  const webDigest = required(
    manifest?.components?.web?.artifactDigest,
    'Manifest Web digest',
    DIGEST_PATTERN,
  );
  const acsOrchestratorDigest = required(
    manifest?.components?.acs?.orchestratorArtifactDigest,
    'Manifest ACS Orchestrator digest',
    DIGEST_PATTERN,
  );
  const acsSandboxImageDigest = required(
    manifest?.components?.acs?.sandboxImageDigest,
    'Manifest ACS Sandbox digest',
    DIGEST_PATTERN,
  );

  equal(webIdentity?.environment, 'staging', 'Web environment');
  equal(webIdentity?.releaseId, releaseId, 'Web release ID');
  equal(webIdentity?.releaseSha, webSourceSha, 'Web component source SHA');
  equal(webIdentity?.configFingerprint, manifestDigest, 'Web Manifest fingerprint');
  equal(webIdentity?.webDigest, webDigest, 'Web artifact digest');

  equal(apiReady?.status, 'ok', 'API readiness');
  equal(apiReady?.release?.environment, 'staging', 'API environment');
  equal(apiReady?.release?.releaseId, releaseId, 'API release ID');
  equal(apiReady?.release?.releaseSha, apiSourceSha, 'API component source SHA');
  equal(apiReady?.release?.serverDigest, serverDigest, 'API artifact digest');
  equal(apiReady?.release?.webDigest, webDigest, 'API-declared Web digest');
  equal(
    apiReady?.release?.acsOrchestratorDigest,
    acsOrchestratorDigest,
    'API-declared ACS Orchestrator digest',
  );
  equal(
    apiReady?.release?.acsSandboxImageDigest,
    acsSandboxImageDigest,
    'API-declared ACS Sandbox digest',
  );

  equal(acsHealth?.status, 'ok', 'ACS health');
  equal(acsHealth?.environment, 'staging', 'ACS environment');
  equal(acsHealth?.releaseId, releaseId, 'ACS release ID');
  equal(acsHealth?.sourceSha, acsSourceSha, 'ACS component source SHA');
  equal(
    acsHealth?.orchestratorArtifactDigest,
    acsOrchestratorDigest,
    'ACS Orchestrator artifact digest',
  );
  equal(acsHealth?.sandboxImageDigest, acsSandboxImageDigest, 'ACS Sandbox image digest');
  equal(acsHealth?.namespace, 'agent-saas-staging', 'ACS namespace');
  equal(acsHealth?.releaseIdentityAttested, true, 'ACS release identity attestation');

  return {
    releaseId,
    releaseSha,
    apiSourceSha,
    webSourceSha,
    acsSourceSha,
    manifestDigest,
    serverDigest,
    webDigest,
    acsOrchestratorDigest,
    acsSandboxImageDigest,
  };
}

function parse(argv) {
  const options = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    options[key.slice(2)] = value;
  }
  return options;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parse(process.argv);
  for (const key of ['manifest', 'web-identity', 'api-ready', 'acs-health']) {
    if (!options[key])
      throw new Error(
        'usage: verify-staging-release-binding.mjs --manifest <file> --web-identity <file> --api-ready <file> --acs-health <file> [--expected-manifest-digest <sha256:...>]',
      );
  }
  const result = verifyStagingReleaseBinding({
    manifest: await readJson(options.manifest),
    webIdentity: await readJson(options['web-identity']),
    apiReady: await readJson(options['api-ready']),
    acsHealth: await readJson(options['acs-health']),
    expectedManifestDigest: options['expected-manifest-digest'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
