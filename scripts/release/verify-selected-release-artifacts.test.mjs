import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
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
    mkdir(join(serverStage, 'daemon-packaging/systemd'), { recursive: true }),
    mkdir(join(acsStage, 'daemon-packaging/systemd'), { recursive: true }),
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
    join(serverStage, 'daemon-packaging/systemd/agent-saas-server@.service.template'),
    '[Service]\nExecStart=/usr/bin/node server/dist/index.js\n',
  );
  await writeFile(
    join(serverStage, 'daemon-packaging/systemd/agent-saas-runtime-worker@.service.template'),
    '[Service]\nExecStart=/usr/bin/node server/dist/runtime-worker.js\n',
  );
  await writeFile(
    join(acsStage, 'runtime-dependencies.json'),
    mismatchedAcsArchive ? serverRuntime : acsRuntime,
  );
  await writeFile(
    join(acsStage, 'daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template'),
    '[Service]\nExecStart=/usr/bin/node acs-orchestrator/dist/index.js\n',
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
    components: {
      web: { action: 'deploy' },
      api: { action: serverSha === SHA ? 'deploy' : 'keep' },
      runtimeWorker: { action: serverSha === SHA ? 'deploy' : 'keep' },
      acs: { action: acsSha === SHA ? 'deploy' : 'keep' },
    },
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
  return { root, selected, manifestPath, manifest, serverStage, acsStage };
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

for (const attack of [
  {
    label: 'Server unit absolute symlink',
    archive: 'serverBundle',
    stage: 'serverStage',
    path: 'daemon-packaging/systemd/agent-saas-server@.service.template',
    apply: (value, target) => symlink('/tmp/production-secret', target),
  },
  {
    label: 'Worker unit hardlink',
    archive: 'serverBundle',
    stage: 'serverStage',
    path: 'daemon-packaging/systemd/agent-saas-runtime-worker@.service.template',
    apply: (value, target) => link(join(value.serverStage, 'runtime-dependencies.json'), target),
  },
  {
    label: 'ACS unit escaping symlink',
    archive: 'acsOrchestrator',
    fixtureOptions: { acsSha: SHA },
    stage: 'acsStage',
    path: 'daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template',
    apply: (value, target) => symlink('../../../../tmp/production-secret', target),
  },
]) {
  test(`rejects ${attack.label} before Promotion extraction`, async () => {
    const value = await fixture(attack.fixtureOptions);
    const target = join(value[attack.stage], attack.path);
    await rm(target);
    await attack.apply(value, target);
    const archivePath = join(
      value.selected,
      attack.archive === 'serverBundle' ? 'server-bundle.tgz' : 'acs-orchestrator.tgz',
    );
    pack(
      join(value.root, attack.stage === 'serverStage' ? 'server-stage' : 'acs-stage'),
      archivePath,
    );
    value.manifest.artifacts[attack.archive] = await digestFile(archivePath);
    await writeFile(value.manifestPath, JSON.stringify(value.manifest));
    await assert.rejects(
      verifySelectedReleaseArtifacts({
        manifestPath: value.manifestPath,
        directory: value.selected,
      }),
      /control file must be a unique regular file/u,
    );
  });
}

test('keep components accept immutable compatibility archives without nested managed units', async () => {
  const value = await fixture({ serverSha: BASE, acsSha: BASE });
  await Promise.all([
    rm(join(value.serverStage, 'daemon-packaging'), { recursive: true }),
    rm(join(value.acsStage, 'daemon-packaging'), { recursive: true }),
  ]);
  const serverArchive = join(value.selected, 'server-bundle.tgz');
  const acsArchive = join(value.selected, 'acs-orchestrator.tgz');
  pack(join(value.root, 'server-stage'), serverArchive);
  pack(join(value.root, 'acs-stage'), acsArchive);
  value.manifest.artifacts.serverBundle = await digestFile(serverArchive);
  value.manifest.artifacts.acsOrchestrator = await digestFile(acsArchive);
  await writeFile(value.manifestPath, JSON.stringify(value.manifest));
  await assert.doesNotReject(
    verifySelectedReleaseArtifacts({
      manifestPath: value.manifestPath,
      directory: value.selected,
    }),
  );
});

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

test('rejects a tar process failure after it has emitted the member listing', async () => {
  const value = await fixture();
  const archive = join(value.selected, 'acs-orchestrator.tgz');
  const bytes = await readFile(archive);
  bytes[bytes.length - 8] ^= 1; // 破坏 gzip CRC，tar 可输出成员但最终退出失败。
  await writeFile(archive, bytes);
  value.manifest.artifacts.acsOrchestrator = await digestFile(archive);
  await writeFile(value.manifestPath, JSON.stringify(value.manifest));
  await assert.rejects(
    verifySelectedReleaseArtifacts({ manifestPath: value.manifestPath, directory: value.selected }),
    /Unable to list selected archive/u,
  );
});

// 直接生成零字节成员，覆盖真实依赖包规模而不创建上万个临时文件。
function emptyTarMember(name) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write('00000000000\0', 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

for (const duplicateAtEnd of [false, true]) {
  test(`streams a listing larger than 1 MiB and ${duplicateAtEnd ? 'rejects a trailing duplicate' : 'verifies the archive'}`, async () => {
    const value = await fixture({ acsSha: SHA });
    const archive = join(value.selected, 'acs-orchestrator.tgz');
    const original = gunzipSync(await readFile(archive));
    let end = original.length;
    const zeroBlock = Buffer.alloc(512);
    while (original.subarray(end - 512, end).equals(zeroBlock)) end -= 512;
    const names = Array.from(
      { length: 16000 },
      (_, index) => `acs-orchestrator/node_modules/${'x'.repeat(50)}/${index}.js`,
    );
    assert.ok(Buffer.byteLength(names.join('\n')) > 1024 * 1024);
    const members = names.map(emptyTarMember);
    if (duplicateAtEnd) {
      members.push(emptyTarMember('acs-orchestrator/./runtime-dependencies.json'));
    }
    await writeFile(
      archive,
      gzipSync(Buffer.concat([original.subarray(0, end), ...members, Buffer.alloc(1024)])),
    );
    value.manifest.artifacts.acsOrchestrator = await digestFile(archive);
    await writeFile(value.manifestPath, JSON.stringify(value.manifest));
    const verification = verifySelectedReleaseArtifacts({
      manifestPath: value.manifestPath,
      directory: value.selected,
    });
    if (duplicateAtEnd) {
      await assert.rejects(
        verification,
        /duplicate normalized member acs-orchestrator\/runtime-dependencies\.json/u,
      );
    } else {
      await assert.doesNotReject(verification);
    }
  });
}
