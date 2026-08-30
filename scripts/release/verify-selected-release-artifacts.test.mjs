import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, digestFile } from './artifact-lib.mjs';
import {
  createRuntimeDependencyIdentity,
  loadRuntimeDependencyContract,
} from './runtime-dependency.mjs';
import { verifySelectedReleaseArtifacts } from './verify-selected-release-artifacts.mjs';

const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function pack(source, output) {
  execFileSync('tar', ['-czf', output, '-C', source, '.']);
}

async function fixture({ mismatchedAcsArchive = false, serverSha = SHA, acsSha = BASE } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'selected-release-'));
  const selected = join(root, 'selected');
  const serverStage = join(root, 'server-stage', 'server');
  const acsStage = join(root, 'acs-stage', 'acs-orchestrator');
  const webStage = join(root, 'web-stage');
  await Promise.all([
    mkdir(serverStage, { recursive: true }),
    mkdir(acsStage, { recursive: true }),
    mkdir(webStage, { recursive: true }),
    mkdir(selected, { recursive: true }),
  ]);
  const contract = await loadRuntimeDependencyContract();
  const serverIdentity = createRuntimeDependencyIdentity(contract, serverSha);
  const acsIdentity = createRuntimeDependencyIdentity(contract, acsSha);
  const serverRuntime = `${canonicalJson(serverIdentity)}\n`;
  const acsRuntime = `${canonicalJson(acsIdentity)}\n`;
  await writeFile(join(serverStage, 'runtime-dependencies.json'), serverRuntime);
  await writeFile(
    join(acsStage, 'runtime-dependencies.json'),
    mismatchedAcsArchive ? serverRuntime : acsRuntime,
  );
  await writeFile(join(webStage, 'index.html'), '<!doctype html>');
  const serverArchive = join(selected, 'server-bundle.tgz');
  const webArchive = join(selected, 'web-assets.tgz');
  const acsArchive = join(selected, 'acs-orchestrator.tgz');
  pack(join(root, 'server-stage'), serverArchive);
  pack(webStage, webArchive);
  pack(join(root, 'acs-stage'), acsArchive);
  const serverRuntimePath = join(selected, 'runtime-dependencies-server.json');
  const acsRuntimePath = join(selected, 'runtime-dependencies-acs.json');
  await writeFile(serverRuntimePath, serverRuntime);
  await writeFile(acsRuntimePath, acsRuntime);

  const runtimeArtifact = async (path, identity) => ({
    ...(await digestFile(path)),
    sourceSha: identity.sourceSha,
    identityDigest: identity.identityDigest,
    dependencyDigest: identity.dependencyDigest,
    contractDigest: identity.contractDigest,
  });
  const manifest = {
    schemaVersion: 2,
    releaseId: 'rc-20260829-01',
    artifacts: {
      serverBundle: await digestFile(serverArchive),
      webAssets: await digestFile(webArchive),
      acsOrchestrator: await digestFile(acsArchive),
      runtimeDependencies: {
        server: await runtimeArtifact(serverRuntimePath, serverIdentity),
        acs: await runtimeArtifact(acsRuntimePath, acsIdentity),
      },
    },
  };
  const manifestPath = join(root, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, selected, manifestPath, manifest };
}

for (const [name, serverSha, acsSha] of [
  ['web-only', BASE, BASE],
  ['app-only', SHA, BASE],
  ['ACS-only', BASE, SHA],
]) {
  test(`verifies ${name} selected archives against component runtime identities`, async () => {
    const value = await fixture({ serverSha, acsSha });
    await assert.doesNotReject(
      verifySelectedReleaseArtifacts({
        manifestPath: value.manifestPath,
        directory: value.selected,
      }),
    );
  });
}

for (const [label, transform] of [
  ['leading dot segment', 's#^server/#./server/#'],
  ['internal dot segment', 's#^server/#server/./#'],
  ['repeated separator', 's#^server/#server//#'],
]) {
  test(`rejects duplicate tar members after normalizing ${label}`, async () => {
    const value = await fixture();
    const source = join(value.root, 'server-stage');
    const archive = join(value.selected, 'server-bundle.tgz');
    const uncompressed = join(value.root, 'duplicate.tar');
    execFileSync('tar', ['-cf', uncompressed, '-C', source, 'server/runtime-dependencies.json']);
    execFileSync('tar', [
      '-rf',
      uncompressed,
      `--transform=${transform}`,
      '-C',
      source,
      'server/runtime-dependencies.json',
    ]);
    await writeFile(archive, execFileSync('gzip', ['-c', uncompressed], { encoding: null }));
    value.manifest.artifacts.serverBundle = await digestFile(archive);
    await writeFile(value.manifestPath, JSON.stringify(value.manifest));
    await assert.rejects(
      verifySelectedReleaseArtifacts({
        manifestPath: value.manifestPath,
        directory: value.selected,
      }),
      /duplicate normalized member server\/runtime-dependencies\.json/u,
    );
  });
}

test('rejects selected archive bytes embedding another component Runtime identity', async () => {
  const value = await fixture({ mismatchedAcsArchive: true });
  await assert.rejects(
    verifySelectedReleaseArtifacts({ manifestPath: value.manifestPath, directory: value.selected }),
    /ACS archive embeds a different Runtime Dependency Identity/iu,
  );
});

test('keeps the explicit historical v1 verification path free of Runtime fields', async () => {
  const value = await fixture();
  value.manifest.schemaVersion = 1;
  delete value.manifest.artifacts.runtimeDependencies;
  await writeFile(value.manifestPath, JSON.stringify(value.manifest));
  const verified = await verifySelectedReleaseArtifacts({
    manifestPath: value.manifestPath,
    directory: value.selected,
  });
  assert.equal(verified.schemaVersion, 1);
});
