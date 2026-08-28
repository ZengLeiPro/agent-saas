#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';

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
  for (const index of indexes) {
    requiredObject(index, 'Baseline artifact index');
    if (index.schemaVersion !== 1) throw new Error('Baseline artifact index version is invalid');
    requiredString(index.sourceSha, 'Baseline source SHA', SHA_PATTERN);
  }
  const components = requiredObject(state.components, 'Production components');
  const web = requiredObject(components.web, 'Production Web');
  const api = requiredObject(components.api, 'Production API');
  const worker = requiredObject(components.runtimeWorker, 'Production Runtime Worker');
  const acs = requiredObject(components.acs, 'Production ACS');
  if (api.gitSha !== worker.gitSha || api.artifactDigest !== worker.artifactDigest) {
    throw new Error('Production API and Runtime Worker do not share one Server baseline');
  }
  return {
    serverBundle: selectFile(indexes, 'serverBundle', api.gitSha, api.artifactDigest),
    webAssets: selectFile(indexes, 'webAssets', web.gitSha, web.artifactDigest),
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
