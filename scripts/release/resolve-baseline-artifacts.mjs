#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson, digestBuffer, DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';

function validateIndex(index) {
  requiredObject(index, 'Baseline artifact index');
  if (![1, 2].includes(index.schemaVersion)) {
    throw new Error('Baseline artifact index version is invalid');
  }
  if (index.schemaVersion === 1 && 'runtimeDependencies' in index) {
    throw new Error('Baseline artifact index v1 cannot contain Runtime Dependency Identity fields');
  }
  requiredString(index.sourceSha, 'Baseline source SHA', SHA_PATTERN);
  requiredObject(index.artifacts, 'Baseline artifact index artifacts');
  if (index.schemaVersion === 2 && !('runtimeDependencies' in index)) {
    throw new Error('Baseline artifact index v2 must own the Runtime Dependency Identity field');
  }
  const aggregateDigest = requiredString(
    index.aggregateDigest,
    'Baseline artifact index aggregate digest',
    DIGEST_PATTERN,
  );
  const body = structuredClone(index);
  delete body.aggregateDigest;
  delete body.indexUri;
  if (digestBuffer(Buffer.from(canonicalJson(body))) !== aggregateDigest) {
    throw new Error('Baseline artifact index aggregate digest mismatch');
  }
}

function requiredObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function requiredString(value, label, pattern) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function safeArtifactPath(value, label) {
  return requiredString(value, label, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s]+$/u);
}

function fileCandidate(index, artifactName, expectedSourceSha, expectedDigest) {
  if (index.sourceSha !== expectedSourceSha) return undefined;
  const artifact = index.artifacts?.[artifactName];
  if (artifact?.digest !== expectedDigest) return undefined;
  const indexUri = requiredString(
    index.indexUri,
    'Baseline artifact index URI',
    /^oss:\/\/[^/]+\/.+\/artifact-index\.json$/u,
  );
  const path = safeArtifactPath(artifact.path, `${artifactName} path`);
  if (!Number.isSafeInteger(artifact.size) || artifact.size < 1) {
    throw new Error(`${artifactName} size is invalid`);
  }
  return {
    uri: `${indexUri.slice(0, -'artifact-index.json'.length)}${path}`,
    digest: requiredString(artifact.digest, `${artifactName} digest`, DIGEST_PATTERN),
    size: artifact.size,
  };
}

function selectFile(indexes, artifactName, expectedSourceSha, expectedDigest) {
  const candidates = indexes
    .map((index) => fileCandidate(index, artifactName, expectedSourceSha, expectedDigest))
    .filter(Boolean)
    .sort((left, right) => left.uri.localeCompare(right.uri));
  if (!candidates.length) throw new Error(`No immutable ${artifactName} matches live Production`);
  if (candidates.some((candidate) => candidate.size !== candidates[0].size)) {
    throw new Error(`Conflicting ${artifactName} sizes share the Production digest`);
  }
  return candidates[0];
}

function runtimeCandidate(index, artifactName, expectedSourceSha, expectedArtifactDigest) {
  if (!fileCandidate(index, artifactName, expectedSourceSha, expectedArtifactDigest))
    return undefined;
  if (!index.runtimeDependencies) return undefined;
  const runtime = requiredObject(index.runtimeDependencies, 'Baseline runtime dependency');
  if (runtime.sourceSha !== expectedSourceSha)
    throw new Error('Baseline runtime dependency source SHA does not match its component');
  const indexUri = requiredString(
    index.indexUri,
    'Baseline artifact index URI',
    /^oss:\/\/[^/]+\/.+\/artifact-index\.json$/u,
  );
  const path = safeArtifactPath(runtime.path, 'Baseline runtime dependency path');
  if (!Number.isSafeInteger(runtime.size) || runtime.size < 1)
    throw new Error('Baseline runtime dependency size is invalid');
  return {
    uri: `${indexUri.slice(0, -'artifact-index.json'.length)}${path}`,
    digest: requiredString(runtime.digest, 'Baseline runtime dependency digest', DIGEST_PATTERN),
    size: runtime.size,
    sourceSha: requiredString(
      runtime.sourceSha,
      'Baseline runtime dependency source SHA',
      SHA_PATTERN,
    ),
    identityDigest: requiredString(
      runtime.identityDigest,
      'Baseline runtime dependency identity digest',
      DIGEST_PATTERN,
    ),
    dependencyDigest: requiredString(
      runtime.dependencyDigest,
      'Baseline runtime dependency dependency digest',
      DIGEST_PATTERN,
    ),
    contractDigest: requiredString(
      runtime.contractDigest,
      'Baseline runtime dependency contract digest',
      DIGEST_PATTERN,
    ),
  };
}

function selectRuntime(indexes, artifactName, expectedSourceSha, expectedArtifactDigest) {
  const candidates = indexes
    .map((index) =>
      runtimeCandidate(index, artifactName, expectedSourceSha, expectedArtifactDigest),
    )
    .filter(Boolean)
    .sort((left, right) => left.uri.localeCompare(right.uri));
  if (!candidates.length) return undefined;
  const expected = candidates[0];
  if (
    candidates.some(
      (candidate) =>
        candidate.digest !== expected.digest ||
        candidate.size !== expected.size ||
        candidate.sourceSha !== expected.sourceSha ||
        candidate.identityDigest !== expected.identityDigest ||
        candidate.dependencyDigest !== expected.dependencyDigest ||
        candidate.contractDigest !== expected.contractDigest,
    )
  ) {
    throw new Error(`Conflicting Runtime Dependency Identities match ${artifactName}`);
  }
  return expected;
}

function selectImage(indexes, expectedSourceSha, expectedDigest) {
  const candidates = indexes
    .filter(
      (index) => index.sourceSha === expectedSourceSha && index.acsImage?.digest === expectedDigest,
    )
    .map((index) => {
      const reference = requiredString(
        index.acsImage.reference,
        'ACS image reference',
        /@sha256:/u,
      );
      const suffix = `@${expectedDigest}`;
      if (!reference.endsWith(suffix)) throw new Error('ACS image reference is not digest-bound');
      const repository = requiredString(
        reference.slice(0, -suffix.length),
        'ACS image repository',
        /^(?!\s*$).+/u,
      );
      return { repository, digest: expectedDigest };
    })
    .sort((left, right) => left.repository.localeCompare(right.repository));
  if (!candidates.length) throw new Error('No immutable ACS image matches live Production');
  if (candidates.some((candidate) => candidate.repository !== candidates[0].repository)) {
    throw new Error('Production ACS image digest appears in conflicting repositories');
  }
  return candidates[0];
}

export function resolveBaselineArtifacts({ production, indexes }) {
  const state = requiredObject(production, 'Production state');
  if (state.environment !== 'production')
    throw new Error('Production state environment is invalid');
  if (!Array.isArray(indexes) || !indexes.length) {
    throw new Error('No immutable baseline artifact indexes were provided');
  }
  for (const index of indexes) validateIndex(index);
  const components = requiredObject(state.components, 'Production components');
  const web = requiredObject(components.web, 'Production Web');
  const api = requiredObject(components.api, 'Production API');
  const worker = requiredObject(components.runtimeWorker, 'Production Runtime Worker');
  const acs = requiredObject(components.acs, 'Production ACS');
  if (api.gitSha !== worker.gitSha || api.artifactDigest !== worker.artifactDigest) {
    throw new Error('Production API and Runtime Worker do not share one Server baseline');
  }
  const serverRuntime = selectRuntime(indexes, 'serverBundle', api.gitSha, api.artifactDigest);
  const acsRuntime = selectRuntime(
    indexes,
    'acsOrchestrator',
    acs.gitSha,
    acs.orchestratorArtifactDigest,
  );
  return {
    serverBundle: selectFile(indexes, 'serverBundle', api.gitSha, api.artifactDigest),
    webAssets: selectFile(indexes, 'webAssets', web.gitSha, web.artifactDigest),
    runtimeDependencies: {
      ...(serverRuntime ? { server: serverRuntime } : {}),
      ...(acsRuntime ? { acs: acsRuntime } : {}),
    },
    acsOrchestrator: selectFile(
      indexes,
      'acsOrchestrator',
      acs.gitSha,
      acs.orchestratorArtifactDigest,
    ),
    acsImage: selectImage(indexes, acs.gitSha, acs.sandboxImageDigest),
  };
}

async function readIndexes(directory) {
  const names = (await readdir(resolve(directory))).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(
    names.map((name) => readFile(resolve(directory, name), 'utf8').then(JSON.parse)),
  );
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
  if (!options.production || !options.indexes || !options.output) {
    throw new Error(
      'usage: resolve-baseline-artifacts.mjs --production <production.json> --indexes <directory> --output <baseline.json>',
    );
  }
  const [production, indexes] = await Promise.all([
    readFile(resolve(options.production), 'utf8').then(JSON.parse),
    readIndexes(options.indexes),
  ]);
  const output = resolveBaselineArtifacts({ production, indexes });
  await writeFile(resolve(options.output), `${JSON.stringify(output, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o444,
  });
}
