#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateReleaseEvidenceDocument } from './release-evidence-schema.mjs';
import { verifyArtifactIndex } from './verify-artifact.mjs';

function parse(argv) {
  const output = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('All options require a value');
    output[key.slice(2)] = value;
  }
  return output;
}

function artifactUri(baseUri, releaseId, path) {
  const base = new URL(baseUri);
  if (!['https:', 'oss:'].includes(base.protocol) || base.username || base.password || base.search)
    throw new Error('Artifact base URI must be an uncredentialed HTTPS or OSS URI');
  return `${baseUri.replace(/\/$/u, '')}/${releaseId}/${path}`;
}

export async function assembleReleaseEvidence(options) {
  const authoritative = validateReleaseEvidenceDocument(
    JSON.parse(await readFile(resolve(options.authoritative), 'utf8')),
    { expectedSha: options.sha },
  );
  const index = await verifyArtifactIndex(options.index, options.sha);
  const createdAt = options['created-at'];
  const expiresAt = options['expires-at'];
  if (!createdAt || !expiresAt || Date.parse(expiresAt) <= Date.parse(createdAt))
    throw new Error('Release timestamps are invalid');
  const built = (name) => {
    const item = index.artifacts[name];
    if (!item) return undefined;
    return {
      uri: artifactUri(options['artifact-base-uri'], options['release-id'], item.path),
      digest: item.digest,
      size: item.size,
    };
  };
  const output = {
    releaseId: options['release-id'],
    releaseSha: options.sha,
    createdAt,
    createdBy: options.actor,
    expiresAt,
    compatibilityEvidenceDigest: authoritative.compatibilityEvidenceDigest,
    integrationCandidates: authoritative.integrationCandidates,
    sourcePullRequests: authoritative.sourcePullRequests,
    checks: authoritative.checks,
    productionBaseline: authoritative.productionBaseline,
    affectedComponents: authoritative.affectedComponents,
    builtArtifacts: {
      serverBundle: built('serverBundle'),
      webAssets: built('webAssets'),
      ...(built('acsOrchestrator') ? { acsOrchestrator: built('acsOrchestrator') } : {}),
      ...(index.acsImage
        ? {
            acsImage: {
              repository: String(index.acsImage.reference).split('@')[0],
              digest: index.acsImage.digest,
            },
          }
        : {}),
    },
    baselineArtifacts: authoritative.baselineArtifacts,
    migrationPlan: authoritative.migrationPlan,
  };
  if (
    !output.releaseId ||
    !output.createdBy ||
    !output.builtArtifacts.serverBundle ||
    !output.builtArtifacts.webAssets
  )
    throw new Error('Release evidence is incomplete');
  await writeFile(resolve(options.output), `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assembleReleaseEvidence(parse(process.argv)).then((value) =>
    process.stdout.write(`${value.releaseId}\n`),
  );
}
