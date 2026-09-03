#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  canonicalJson,
  digestBuffer,
  digestFile,
  DIGEST_PATTERN,
  OCI_IMAGE_REFERENCE_PATTERN,
  SHA_PATTERN,
} from './artifact-lib.mjs';
import { verifyRuntimeDependencyIdentity } from './runtime-dependency.mjs';

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

function assertFileDescriptor(entry, label, { path = true } = {}) {
  assertExactKeys(entry, path ? ['path', 'digest', 'size'] : ['digest', 'size'], label);
  if (
    (path && typeof entry.path !== 'string') ||
    !DIGEST_PATTERN.test(entry.digest ?? '') ||
    !Number.isSafeInteger(entry.size) ||
    entry.size < 1
  ) {
    throw new Error(`${label} path/digest/size is invalid`);
  }
}

function safePath(root, relativePath) {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('..'))
    throw new Error(`Unsafe artifact path: ${relativePath}`);
  const output = resolve(root, relativePath);
  if (!output.startsWith(`${resolve(root)}${sep}`)) throw new Error('Artifact escaped root');
  return output;
}

export async function verifyArtifactIndex(indexPath, expectedSha) {
  const absolute = resolve(indexPath);
  const index = JSON.parse(await readFile(absolute, 'utf8'));
  if (![1, 2].includes(index.schemaVersion) || !SHA_PATTERN.test(index.sourceSha))
    throw new Error('Invalid artifact index identity');
  if (index.schemaVersion === 1 && 'runtimeDependencies' in index) {
    throw new Error('Artifact index v1 cannot contain Runtime Dependency Identity fields');
  }
  if (index.schemaVersion === 2 && !index.runtimeDependencies) {
    throw new Error('Artifact index v2 requires a Runtime Dependency Identity');
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
  if (expectedSha && index.sourceSha !== expectedSha)
    throw new Error('Artifact source SHA mismatch');
  const { aggregateDigest, ...body } = index;
  if (!DIGEST_PATTERN.test(aggregateDigest ?? '')) throw new Error('Invalid aggregate digest');
  if (digestBuffer(Buffer.from(canonicalJson(body))) !== aggregateDigest)
    throw new Error('Artifact index aggregate digest mismatch');
  const root = dirname(absolute);
  if (!index.artifacts || typeof index.artifacts !== 'object' || Array.isArray(index.artifacts))
    throw new Error('Artifact index artifacts are missing');
  // 新 Staging bundle 与创建它之前的不可变 RC 共用同一 schema，故允许该受控可选项。
  const artifactNames = Object.keys(index.artifacts).sort();
  if (
    !artifactNames.includes('serverBundle') ||
    !artifactNames.includes('webAssets') ||
    artifactNames.some(
      (name) =>
        !['serverBundle', 'webAssets', 'stagingRuntimeAssets', 'acsOrchestrator'].includes(name),
    )
  ) {
    throw new Error('Artifact index must contain the complete supported artifact set');
  }
  if (artifactNames.includes('acsOrchestrator') !== Boolean(index.acsImage))
    throw new Error('ACS Orchestrator artifact and image identity must be present together');
  for (const [name, artifact] of Object.entries(index.artifacts)) {
    assertFileDescriptor(artifact, `Artifact index ${name}`);
  }
  assertFileDescriptor(index.sbom, 'Artifact index SBOM');
  if (index.schemaVersion === 2) {
    assertExactKeys(
      index.runtimeDependencies,
      [
        'path',
        'digest',
        'size',
        'sourceSha',
        'identityDigest',
        'contractDigest',
        'dependencyDigest',
      ],
      'Artifact index Runtime Dependency Identity',
    );
  }
  if (index.acsImage) {
    assertExactKeys(
      index.acsImage,
      ['sourceSha', 'reference', 'digest'],
      'Artifact index ACS image',
    );
    if (
      typeof index.acsImage.reference !== 'string' ||
      !OCI_IMAGE_REFERENCE_PATTERN.test(index.acsImage.reference)
    ) {
      throw new Error('Artifact index ACS image reference is invalid');
    }
  }
  const entries = [...Object.values(index.artifacts), index.sbom, index.runtimeDependencies].filter(
    Boolean,
  );
  for (const entry of entries) {
    if (
      !DIGEST_PATTERN.test(entry.digest ?? '') ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0
    )
      throw new Error('Invalid artifact entry');
    const actual = await digestFile(safePath(root, entry.path));
    if (actual.digest !== entry.digest || actual.size !== entry.size)
      throw new Error(`Artifact verification failed: ${entry.path}`);
  }
  if (!index.sbom) throw new Error('SBOM is missing');
  const sbom = JSON.parse(await readFile(safePath(root, index.sbom.path), 'utf8'));
  if (sbom.schemaVersion !== index.schemaVersion || sbom.sourceSha !== index.sourceSha) {
    throw new Error('SBOM version/source identity conflicts with artifact index');
  }
  assertExactKeys(
    sbom,
    [
      'schemaVersion',
      'sourceSha',
      'lockfile',
      ...(sbom.schemaVersion === 2 ? ['runtimeDependencies'] : []),
      'packages',
    ],
    `SBOM v${sbom.schemaVersion}`,
  );
  assertFileDescriptor(sbom.lockfile, 'SBOM lockfile', { path: false });
  if (
    !Array.isArray(sbom.packages) ||
    sbom.packages.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))
  ) {
    throw new Error('SBOM packages must be an array of package objects');
  }
  if (index.schemaVersion === 2) {
    assertExactKeys(
      sbom.runtimeDependencies,
      ['sourceSha', 'identityDigest', 'contractDigest', 'dependencyDigest'],
      'SBOM Runtime Dependency Identity',
    );
    if (
      index.runtimeDependencies.sourceSha !== index.sourceSha ||
      !DIGEST_PATTERN.test(index.runtimeDependencies.identityDigest ?? '') ||
      !DIGEST_PATTERN.test(index.runtimeDependencies.contractDigest ?? '') ||
      !DIGEST_PATTERN.test(index.runtimeDependencies.dependencyDigest ?? '')
    ) {
      throw new Error('Artifact index runtime dependency identity is missing or invalid');
    }
    if (
      sbom.runtimeDependencies?.sourceSha !== index.sourceSha ||
      !DIGEST_PATTERN.test(sbom.runtimeDependencies?.identityDigest ?? '') ||
      !DIGEST_PATTERN.test(sbom.runtimeDependencies?.contractDigest ?? '') ||
      !DIGEST_PATTERN.test(sbom.runtimeDependencies?.dependencyDigest ?? '') ||
      sbom.runtimeDependencies.identityDigest !== index.runtimeDependencies.identityDigest ||
      sbom.runtimeDependencies.contractDigest !== index.runtimeDependencies.contractDigest ||
      sbom.runtimeDependencies.dependencyDigest !== index.runtimeDependencies.dependencyDigest
    ) {
      throw new Error('SBOM runtime dependency identity conflicts with artifact index');
    }
    const runtimeIdentity = verifyRuntimeDependencyIdentity(
      JSON.parse(await readFile(safePath(root, index.runtimeDependencies.path), 'utf8')),
      {
        sourceSha: index.sourceSha,
        contractDigest: index.runtimeDependencies.contractDigest,
      },
    );
    if (
      runtimeIdentity.identityDigest !== index.runtimeDependencies.identityDigest ||
      runtimeIdentity.contractDigest !== index.runtimeDependencies.contractDigest ||
      runtimeIdentity.dependencyDigest !== index.runtimeDependencies.dependencyDigest
    ) {
      throw new Error('Runtime dependency identity conflicts with artifact index');
    }
  }
  if (index.acsImage) {
    if (index.acsImage.sourceSha !== index.sourceSha || !DIGEST_PATTERN.test(index.acsImage.digest))
      throw new Error('ACS image is not bound to the release SHA');
    if (!String(index.acsImage.reference).endsWith(`@${index.acsImage.digest}`))
      throw new Error('ACS image reference is mutable or conflicts with its digest');
  }
  return index;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const indexArg = process.argv[2];
  const shaArg = process.argv[3];
  if (!indexArg) throw new Error('usage: verify-artifact.mjs <artifact-index.json> [expected-sha]');
  verifyArtifactIndex(indexArg, shaArg).then((value) =>
    process.stdout.write(`${value.aggregateDigest}\n`),
  );
}
