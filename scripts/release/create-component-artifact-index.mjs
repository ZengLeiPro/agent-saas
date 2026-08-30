#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import {
  canonicalJson,
  digestBuffer,
  digestFile,
  DIGEST_PATTERN,
  SHA_PATTERN,
} from './artifact-lib.mjs';
import { verifyRuntimeDependencyIdentity } from './runtime-dependency.mjs';

const ARTIFACT_INDEX_VERSION = 2;
const ARTIFACT_NAMES = new Set(['serverBundle', 'webAssets', 'acsOrchestrator']);

export async function createComponentArtifactIndex({
  sourceSha,
  artifactName,
  artifactPath,
  imageReference,
  runtimeDependencyPath,
}) {
  if (!SHA_PATTERN.test(sourceSha ?? '')) throw new Error('Source SHA must be complete');
  if (!ARTIFACT_NAMES.has(artifactName)) throw new Error('Unsupported component artifact name');
  const artifact = { path: basename(artifactPath), ...(await digestFile(resolve(artifactPath))) };
  let acsImage = null;
  if (imageReference) {
    const match = String(imageReference).match(/@(?<digest>sha256:[a-f0-9]{64})$/u);
    if (!match?.groups || !DIGEST_PATTERN.test(match.groups.digest)) {
      throw new Error('ACS image reference must be immutable');
    }
    acsImage = {
      sourceSha,
      reference: String(imageReference),
      digest: match.groups.digest,
    };
  }
  let runtimeDependencies = null;
  if (runtimeDependencyPath) {
    const identity = JSON.parse(await readFile(resolve(runtimeDependencyPath), 'utf8'));
    verifyRuntimeDependencyIdentity(identity, { sourceSha });
    runtimeDependencies = {
      path: basename(runtimeDependencyPath),
      ...(await digestFile(resolve(runtimeDependencyPath))),
      sourceSha,
      identityDigest: identity.identityDigest,
      dependencyDigest: identity.dependencyDigest,
      contractDigest: identity.contractDigest,
    };
  }
  const body = {
    schemaVersion: ARTIFACT_INDEX_VERSION,
    sourceSha,
    artifacts: { [artifactName]: artifact },
    acsImage,
    runtimeDependencies,
  };
  return { ...body, aggregateDigest: digestBuffer(Buffer.from(canonicalJson(body))) };
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
  if (!options.sha || !options.name || !options.file || !options.output) {
    throw new Error(
      'usage: create-component-artifact-index.mjs --sha <sha> --name <name> --file <path> --output <path> [--image-reference <ref>] [--runtime-dependencies <identity.json>]',
    );
  }
  const index = await createComponentArtifactIndex({
    sourceSha: options.sha,
    artifactName: options.name,
    artifactPath: options.file,
    imageReference: options['image-reference'],
    runtimeDependencyPath: options['runtime-dependencies'],
  });
  await writeFile(resolve(options.output), `${canonicalJson(index)}\n`, {
    flag: 'wx',
    mode: 0o444,
  });
  process.stdout.write(`${index.aggregateDigest}\n`);
}
