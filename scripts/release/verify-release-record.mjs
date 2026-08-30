#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson, digestBuffer, DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(allowed)) {
    throw new Error(`${label} fields must be exactly [${allowed.join(', ')}]`);
  }
}

export function validateReleaseManifestAuthoritatively(manifestPath, releaseId) {
  try {
    execFileSync(
      'pnpm',
      [
        '-F',
        'server',
        'exec',
        'tsx',
        'src/release/validateReleaseManifestCli.ts',
        resolve(manifestPath),
        releaseId,
      ],
      { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const detail = [error?.stderr, error?.stdout]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
      .join('\n');
    throw new Error(
      `Authoritative versioned Release Manifest validation failed${detail ? `: ${detail}` : ''}`,
    );
  }
}

function assertDigest(value, label) {
  if (!DIGEST_PATTERN.test(value ?? '')) throw new Error(`${label} is invalid`);
}

function assertIndexEntry(entry, label) {
  assertExactKeys(entry, ['path', 'digest', 'size'], label);
  if (
    !/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\s]+$/u.test(entry.path) ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 1
  ) {
    throw new Error(`${label} path/size is invalid`);
  }
  assertDigest(entry.digest, `${label} digest`);
}

function assertFileBinding(manifestArtifact, indexArtifact, label) {
  if (
    !indexArtifact ||
    manifestArtifact.digest !== indexArtifact.digest ||
    manifestArtifact.size !== indexArtifact.size ||
    !new URL(manifestArtifact.uri).pathname.endsWith(`/${indexArtifact.path}`)
  ) {
    throw new Error(`Release Manifest ${label} does not match the complete artifact index`);
  }
}

function assertRuntimeBinding(manifestArtifact, index, label) {
  const runtime = index.runtimeDependencies;
  if (
    !runtime ||
    manifestArtifact.digest !== runtime.digest ||
    manifestArtifact.size !== runtime.size ||
    manifestArtifact.sourceSha !== index.sourceSha ||
    manifestArtifact.identityDigest !== runtime.identityDigest ||
    manifestArtifact.dependencyDigest !== runtime.dependencyDigest ||
    manifestArtifact.contractDigest !== runtime.contractDigest ||
    !new URL(manifestArtifact.uri).pathname.endsWith(`/${runtime.path}`)
  ) {
    throw new Error(
      `Release Manifest ${label} runtime identity does not match the complete artifact index`,
    );
  }
}

export function assertManifestIndexBindings(manifest, index) {
  if (manifest.components.api.action === 'deploy') {
    assertFileBinding(manifest.artifacts.serverBundle, index.artifacts.serverBundle, 'Server');
  }
  if (manifest.components.web.action === 'deploy') {
    assertFileBinding(manifest.artifacts.webAssets, index.artifacts.webAssets, 'Web');
  }
  if (manifest.components.acs.action === 'deploy') {
    assertFileBinding(
      manifest.artifacts.acsOrchestrator,
      index.artifacts.acsOrchestrator,
      'ACS Orchestrator',
    );
    if (
      !index.acsImage ||
      manifest.artifacts.acsImage.digest !== index.acsImage.digest ||
      manifest.artifacts.acsImage.repository !== String(index.acsImage.reference).split('@')[0]
    ) {
      throw new Error('Release Manifest ACS image does not match the artifact index');
    }
  }
  if (manifest.schemaVersion === 2) {
    if (manifest.components.api.action === 'deploy') {
      assertRuntimeBinding(manifest.artifacts.runtimeDependencies.server, index, 'Server');
    }
    if (manifest.components.acs.action === 'deploy') {
      assertRuntimeBinding(manifest.artifacts.runtimeDependencies.acs, index, 'ACS');
    }
  }
}

export async function verifyReleaseRecordFiles({
  recordPath,
  manifestPath,
  indexPath,
  validateManifest = true,
}) {
  const [record, manifest, index] = await Promise.all(
    [recordPath, manifestPath, indexPath].map(async (path) =>
      JSON.parse(await readFile(resolve(path), 'utf8')),
    ),
  );

  if (validateManifest) {
    validateReleaseManifestAuthoritatively(manifestPath, manifest.releaseId);
  }

  assertExactKeys(
    record,
    [
      'schemaVersion',
      'releaseId',
      'releaseSha',
      'manifestDigest',
      'manifestFileDigest',
      'artifactDigest',
      'manifestFile',
      'artifactIndexFile',
    ],
    'Release record',
  );
  if (record.schemaVersion !== 1) throw new Error('Release record schemaVersion is invalid');
  if (!/^rc-\d{8}-\d{2,}$/u.test(record.releaseId ?? '')) {
    throw new Error('Release record releaseId is invalid');
  }
  if (!SHA_PATTERN.test(record.releaseSha ?? '')) {
    throw new Error('Release record releaseSha is invalid');
  }
  for (const [value, label] of [
    [record.manifestDigest, 'Release record manifestDigest'],
    [record.manifestFileDigest, 'Release record manifestFileDigest'],
    [record.artifactDigest, 'Release record artifactDigest'],
  ]) {
    assertDigest(value, label);
  }
  if (
    record.manifestFile !== 'manifest.json' ||
    record.artifactIndexFile !== 'artifact-index.json'
  ) {
    throw new Error('Release record file names are invalid');
  }

  if (![1, 2].includes(manifest.schemaVersion)) {
    throw new Error('Release Manifest schemaVersion is invalid');
  }
  const { digest: manifestDigest, ...manifestContent } = manifest;
  assertDigest(manifestDigest, 'Release Manifest digest');
  const calculatedManifestDigest = digestBuffer(
    Buffer.concat([
      Buffer.from(`agent-saas-release-manifest-v${manifest.schemaVersion}\0`),
      Buffer.from(canonicalJson(manifestContent)),
    ]),
  );
  if (manifestDigest !== calculatedManifestDigest) {
    throw new Error('Release Manifest digest does not match canonical domain-separated content');
  }
  const manifestFileDigest = digestBuffer(Buffer.from(canonicalJson(manifest)));

  if (![1, 2].includes(index.schemaVersion) || !SHA_PATTERN.test(index.sourceSha ?? '')) {
    throw new Error('Artifact index identity is invalid');
  }
  if (manifest.schemaVersion !== index.schemaVersion) {
    throw new Error('Release Manifest and artifact index schema versions must match');
  }
  assertExactKeys(
    index,
    [
      'schemaVersion',
      'sourceSha',
      'artifacts',
      'sbom',
      ...(index.schemaVersion === 2 ? ['runtimeDependencies'] : []),
      'acsImage',
      'aggregateDigest',
    ],
    `Artifact index v${index.schemaVersion}`,
  );
  const { aggregateDigest, ...indexBody } = index;
  assertDigest(aggregateDigest, 'Artifact index aggregateDigest');
  if (digestBuffer(Buffer.from(canonicalJson(indexBody))) !== aggregateDigest) {
    throw new Error('Artifact index aggregate digest mismatch');
  }
  if (!index.artifacts || typeof index.artifacts !== 'object' || Array.isArray(index.artifacts)) {
    throw new Error('Artifact index artifacts are missing');
  }
  const artifactNames = Object.keys(index.artifacts).sort();
  if (
    !artifactNames.includes('serverBundle') ||
    !artifactNames.includes('webAssets') ||
    artifactNames.some(
      (name) => !['serverBundle', 'webAssets', 'acsOrchestrator'].includes(name),
    ) ||
    artifactNames.includes('acsOrchestrator') !== Boolean(index.acsImage)
  ) {
    throw new Error('Artifact index supported artifact set is invalid');
  }
  for (const [name, artifact] of Object.entries(index.artifacts)) {
    assertIndexEntry(artifact, `Artifact index ${name}`);
  }
  if (!index.sbom) throw new Error('Artifact index SBOM is missing');
  assertIndexEntry(index.sbom, 'Artifact index SBOM');
  if (index.schemaVersion === 1 && 'runtimeDependencies' in index) {
    throw new Error('Artifact index v1 cannot contain Runtime Dependency Identity fields');
  }
  if (index.schemaVersion === 2 && !index.runtimeDependencies) {
    throw new Error('Artifact index v2 requires a Runtime Dependency Identity');
  }
  if (index.schemaVersion === 2) {
    const { sourceSha, identityDigest, dependencyDigest, contractDigest, ...runtimeFile } =
      index.runtimeDependencies;
    assertIndexEntry(runtimeFile, 'Artifact index Runtime Dependency Identity');
    if (
      sourceSha !== index.sourceSha ||
      ![identityDigest, dependencyDigest, contractDigest].every((value) =>
        DIGEST_PATTERN.test(value ?? ''),
      )
    ) {
      throw new Error('Artifact index Runtime Dependency Identity metadata is invalid');
    }
  }
  if (index.acsImage) {
    if (
      index.acsImage.sourceSha !== index.sourceSha ||
      !DIGEST_PATTERN.test(index.acsImage.digest ?? '') ||
      !String(index.acsImage.reference).endsWith(`@${index.acsImage.digest}`)
    ) {
      throw new Error('Artifact index ACS image identity is invalid');
    }
  }
  assertManifestIndexBindings(manifest, index);

  if (
    record.releaseId !== manifest.releaseId ||
    record.releaseSha !== manifest.releaseSha ||
    record.releaseSha !== index.sourceSha ||
    record.manifestDigest !== manifestDigest ||
    record.manifestFileDigest !== manifestFileDigest ||
    record.artifactDigest !== aggregateDigest
  ) {
    throw new Error('Release record does not bind the exact Manifest and artifact index');
  }
  return record;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [recordPath, manifestPath, indexPath] = process.argv.slice(2);
  if (!recordPath || !manifestPath || !indexPath) {
    throw new Error('usage: verify-release-record.mjs <record> <manifest> <artifact-index>');
  }
  verifyReleaseRecordFiles({ recordPath, manifestPath, indexPath }).then((record) =>
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`),
  );
}
