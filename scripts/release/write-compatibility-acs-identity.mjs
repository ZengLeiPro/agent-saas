#!/usr/bin/env node
import { renameSync, writeFileSync } from 'node:fs';
import { canonicalJson, DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';

const RELEASE_ID_PATTERN = /^rc-[0-9]{8}-[0-9]{2,}$/u;

export function buildCompatibilityAcsIdentity({
  releaseId,
  sourceSha,
  orchestratorArtifactDigest,
  sandboxImageDigest,
  namespace,
  configFingerprint,
}) {
  if (!RELEASE_ID_PATTERN.test(releaseId ?? '')) throw new Error('Release ID is invalid');
  if (!SHA_PATTERN.test(sourceSha ?? '')) throw new Error('Source SHA must be complete');
  for (const [name, digest] of Object.entries({
    orchestratorArtifactDigest,
    sandboxImageDigest,
    configFingerprint,
  })) {
    if (!DIGEST_PATTERN.test(digest ?? '')) throw new Error(`${name} is invalid`);
  }
  if (typeof namespace !== 'string' || !namespace.trim()) throw new Error('Namespace is invalid');
  return {
    schemaVersion: 1,
    environment: 'production',
    releaseId,
    sourceSha,
    orchestratorArtifactDigest,
    sandboxImageDigest,
    namespace,
    configFingerprint,
  };
}

function parse(argv) {
  const output = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    output[key.slice(2)] = value;
  }
  return output;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parse(process.argv);
  const required = [
    'output',
    'release-id',
    'sha',
    'orchestrator-digest',
    'sandbox-image-digest',
    'namespace',
    'config-fingerprint',
  ];
  if (required.some((name) => !options[name])) {
    throw new Error(`Missing required option: ${required.find((name) => !options[name])}`);
  }
  const identity = buildCompatibilityAcsIdentity({
    releaseId: options['release-id'],
    sourceSha: options.sha,
    orchestratorArtifactDigest: options['orchestrator-digest'],
    sandboxImageDigest: options['sandbox-image-digest'],
    namespace: options.namespace,
    configFingerprint: options['config-fingerprint'],
  });
  writeFileSync(`${options.output}.candidate`, `${canonicalJson(identity)}\n`, { mode: 0o444 });
  renameSync(`${options.output}.candidate`, options.output);
  process.stdout.write(`${options['release-id']}\n`);
}
