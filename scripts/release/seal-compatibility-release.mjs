#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  canonicalJson,
  digestBuffer,
  digestFile,
  DIGEST_PATTERN,
  SHA_PATTERN,
} from './artifact-lib.mjs';
import { sealInstalledRelease } from './verify-installed-release.mjs';

const RELEASE_ID_PATTERN = /^rc-[0-9]{8}-[0-9]{2,}$/u;

export async function sealCompatibilityRelease({
  rootPath,
  component,
  releaseId,
  sourceSha,
  sandboxImageDigest,
}) {
  if (!['server', 'acs'].includes(component)) throw new Error('Component must be server or acs');
  if (!RELEASE_ID_PATTERN.test(releaseId ?? '')) throw new Error('Release ID is invalid');
  if (!SHA_PATTERN.test(sourceSha ?? '')) throw new Error('Source SHA must be complete');
  if (component === 'acs' && !DIGEST_PATTERN.test(sandboxImageDigest ?? '')) {
    throw new Error('ACS Sandbox image digest is invalid');
  }
  const root = resolve(rootPath);
  const archiveName = component === 'server' ? 'server-bundle.tgz' : 'acs-orchestrator.tgz';
  const archive = await digestFile(join(root, '.release', archiveName));
  const content = {
    schemaVersion: 1,
    releaseId,
    releaseSha: sourceSha,
    compatibilityDeployment: true,
    components:
      component === 'server'
        ? {
            api: { sourceSha, artifactDigest: archive.digest },
            runtimeWorker: { sourceSha, artifactDigest: archive.digest },
          }
        : {
            acs: {
              sourceSha,
              orchestratorArtifactDigest: archive.digest,
              sandboxImageDigest,
            },
          },
  };
  const digest = digestBuffer(
    Buffer.concat([
      Buffer.from('agent-saas-release-manifest-v1\0'),
      Buffer.from(canonicalJson(content)),
    ]),
  );
  const manifest = { ...content, digest };
  await writeFile(join(root, 'manifest.json'), `${canonicalJson(manifest)}\n`, {
    flag: 'wx',
    mode: 0o444,
  });
  const installed = await sealInstalledRelease(root, component);
  return { manifest, installed };
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
  if (!options.root || !options.component || !options['release-id'] || !options.sha) {
    throw new Error(
      'usage: seal-compatibility-release.mjs --root <path> --component <server|acs> --release-id <id> --sha <sha> [--sandbox-image-digest <digest>]',
    );
  }
  const result = await sealCompatibilityRelease({
    rootPath: options.root,
    component: options.component,
    releaseId: options['release-id'],
    sourceSha: options.sha,
    sandboxImageDigest: options['sandbox-image-digest'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
