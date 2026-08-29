#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import {
  canonicalJson,
  digestBuffer,
  digestFile,
  DIGEST_PATTERN,
  SHA_PATTERN,
} from './artifact-lib.mjs';
import { verifyRuntimeDependencyIdentity } from './runtime-dependency.mjs';

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
  if (index.schemaVersion !== 1 || !SHA_PATTERN.test(index.sourceSha))
    throw new Error('Invalid artifact index identity');
  if (expectedSha && index.sourceSha !== expectedSha)
    throw new Error('Artifact source SHA mismatch');
  const { aggregateDigest, ...body } = index;
  if (!DIGEST_PATTERN.test(aggregateDigest ?? '')) throw new Error('Invalid aggregate digest');
  if (digestBuffer(Buffer.from(canonicalJson(body))) !== aggregateDigest)
    throw new Error('Artifact index aggregate digest mismatch');
  const root = dirname(absolute);
  const entries = [
    ...Object.values(index.artifacts ?? {}),
    index.sbom,
    index.runtimeDependencies,
  ].filter(Boolean);
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
  if (!index.runtimeDependencies) throw new Error('Runtime dependency identity is missing');
  if (
    !DIGEST_PATTERN.test(index.runtimeDependencies.contractDigest ?? '') ||
    !DIGEST_PATTERN.test(index.runtimeDependencies.dependencyDigest ?? '')
  )
    throw new Error('Artifact index runtime dependency digests are missing or invalid');
  const sbom = JSON.parse(await readFile(safePath(root, index.sbom.path), 'utf8'));
  if (sbom.schemaVersion !== 1 || sbom.sourceSha !== index.sourceSha)
    throw new Error('SBOM source identity conflicts with artifact index');
  if (
    !DIGEST_PATTERN.test(sbom.runtimeDependencies?.contractDigest ?? '') ||
    !DIGEST_PATTERN.test(sbom.runtimeDependencies?.dependencyDigest ?? '') ||
    sbom.runtimeDependencies.contractDigest !== index.runtimeDependencies.contractDigest ||
    sbom.runtimeDependencies.dependencyDigest !== index.runtimeDependencies.dependencyDigest
  )
    throw new Error('SBOM runtime dependency identity conflicts with artifact index');
  const runtimeIdentity = verifyRuntimeDependencyIdentity(
    JSON.parse(await readFile(safePath(root, index.runtimeDependencies.path), 'utf8')),
    {
      sourceSha: index.sourceSha,
      contractDigest: index.runtimeDependencies.contractDigest,
    },
  );
  if (
    runtimeIdentity.contractDigest !== index.runtimeDependencies.contractDigest ||
    runtimeIdentity.dependencyDigest !== index.runtimeDependencies.dependencyDigest
  )
    throw new Error('Runtime dependency identity conflicts with artifact index');
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
