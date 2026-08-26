#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';

export function resolveAcrImage({ releaseSha, buildRecord, tagRecord, registry, repository }) {
  if (!SHA_PATTERN.test(releaseSha ?? '')) throw new Error('releaseSha must be complete');
  const tag = buildRecord?.Image?.ImageTag;
  if (buildRecord?.BuildStatus !== 'SUCCESS' || typeof tag !== 'string')
    throw new Error('ACR build record is not successful');
  if (!tag.endsWith(`-${releaseSha.slice(0, 6)}`))
    throw new Error('ACR build tag is not bound to the release SHA prefix');
  const rawDigest = String(tagRecord?.Digest ?? '');
  const digest = rawDigest.startsWith('sha256:') ? rawDigest : `sha256:${rawDigest}`;
  if (!DIGEST_PATTERN.test(digest)) throw new Error('ACR tag did not return an image digest');
  if (tagRecord?.Status !== 'NORMAL') throw new Error('ACR image tag is not normal');
  if (!registry || !repository || /[@:]/u.test(repository))
    throw new Error('Invalid ACR repository');
  return {
    sourceSha: releaseSha,
    tag,
    digest,
    reference: `${registry.replace(/\/$/u, '')}/${repository}@${digest}`,
    buildRecordId: String(buildRecord.BuildRecordId ?? ''),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [releaseSha, buildPath, tagPath, registry, repository] = process.argv.slice(2);
  if (!releaseSha || !buildPath || !tagPath || !registry || !repository)
    throw new Error(
      'usage: resolve-acr-image.mjs <sha> <build.json> <tag.json> <registry> <repository>',
    );
  Promise.all([readFile(buildPath, 'utf8'), readFile(tagPath, 'utf8')]).then(([build, tag]) => {
    process.stdout.write(
      `${JSON.stringify(resolveAcrImage({ releaseSha, buildRecord: JSON.parse(build), tagRecord: JSON.parse(tag), registry, repository }))}\n`,
    );
  });
}
