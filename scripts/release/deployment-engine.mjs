#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const ENGINE_CONTRACT = Object.freeze({
  schemaVersion: 1,
  manifestVersions: [1, 2],
  rollbackReceiptVersions: [1],
});
export function assertEngineCompatibility(manifest) {
  assert(
    ENGINE_CONTRACT.manifestVersions.includes(manifest?.schemaVersion),
    'Deployment engine does not support this manifest schema',
  );
}
export async function deploymentEngine(workflow, root = process.cwd()) {
  assert(
    ['.github/workflows/promote-release.yml', '.github/workflows/deploy-staging.yml'].includes(
      workflow,
    ),
  );
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const sourceSha = git('rev-parse', 'HEAD');
  const paths = git(
    'ls-files',
    '-z',
    'scripts',
    '.github/actions',
    workflow,
    'server/src/release',
    'config',
    'pnpm-lock.yaml',
    'package.json',
  )
    .split('\0')
    .filter(Boolean)
    .sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path + '\0');
    hash.update(await readFile(resolve(root, path)));
    hash.update('\0');
  }
  return {
    schemaVersion: 1,
    contract: ENGINE_CONTRACT,
    sourceSha,
    workflow,
    implementationDigest: 'sha256:' + hash.digest('hex'),
    fileCount: paths.length,
  };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [workflow, output, manifestPath] = process.argv.slice(2);
  if (manifestPath) assertEngineCompatibility(JSON.parse(await readFile(manifestPath, 'utf8')));
  await writeFile(output, JSON.stringify(await deploymentEngine(workflow), null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
