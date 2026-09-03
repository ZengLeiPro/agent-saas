import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, digestBuffer, digestFile } from './artifact-lib.mjs';
import { publishReleaseRecord } from './publish-release-record.mjs';
import { assertAcsImageIdentity, verifyReleaseRecordFiles } from './verify-release-record.mjs';
import {
  createRuntimeDependencyIdentity,
  loadRuntimeDependencyContract,
} from './runtime-dependency.mjs';

const SHA = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const IMAGE = `sha256:${'e'.repeat(64)}`;
const BASE_WEB = `sha256:${'f'.repeat(64)}`;

test('Release Record ACS image identity accepts one canonical digest reference only', () => {
  const digest = `sha256:${'d'.repeat(64)}`;
  const valid = {
    sourceSha: SHA,
    digest,
    reference: `registry.example.com:5000/team/acs-sandbox@${digest}`,
  };
  assert.equal(assertAcsImageIdentity(valid, SHA), 'registry.example.com:5000/team/acs-sandbox');

  for (const reference of [
    `@${digest}`,
    `---@${digest}`,
    `registry.example.com/team/acs-sandbox@@${digest}`,
    'registry.example.com/team/acs-sandbox:latest',
    `registry.example.com/team/acs-sandbox:latest@${digest}`,
    'registry.example.com/team/acs-sandbox',
    'registry.example.com/team/acs-sandbox@sha256:',
  ]) {
    assert.throws(
      () => assertAcsImageIdentity({ sourceSha: SHA, digest, reference }, SHA),
      /Artifact index ACS image identity is invalid/u,
      reference,
    );
  }
});

function signManifest(content) {
  return {
    ...content,
    digest: digestBuffer(
      Buffer.concat([
        Buffer.from(`agent-saas-release-manifest-v${content.schemaVersion}\0`),
        Buffer.from(canonicalJson(content)),
      ]),
    ),
  };
}

async function createArchiveWithRuntimeAndUnits(root, target, component, identity, extra = '') {
  const stage = join(root, `${component}-${Math.random().toString(16).slice(2)}`);
  const componentRoot = join(stage, component);
  await mkdir(componentRoot, { recursive: true });
  await writeFile(join(componentRoot, 'runtime-dependencies.json'), `${canonicalJson(identity)}\n`);
  const systemdRoot = join(componentRoot, 'daemon-packaging/systemd');
  await mkdir(systemdRoot, { recursive: true });
  if (component === 'server') {
    await writeFile(
      join(systemdRoot, 'agent-saas-server@.service.template'),
      '[Service]\nExecStart=/usr/bin/node server/dist/index.js\n',
    );
    await writeFile(
      join(systemdRoot, 'agent-saas-runtime-worker@.service.template'),
      '[Service]\nExecStart=/usr/bin/node server/dist/runtime-worker.js\n',
    );
  } else {
    await writeFile(
      join(systemdRoot, 'agent-saas-acs-orchestrator.service.template'),
      '[Service]\nExecStart=/usr/bin/node acs-orchestrator/dist/index.js\n',
    );
  }
  if (extra) await writeFile(join(componentRoot, 'extra.txt'), extra);
  execFileSync('tar', ['-czf', target, '-C', stage, component]);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'release-record-'));
  const selectedDirectory = join(root, 'selected');
  await mkdir(selectedDirectory);
  const server = join(root, 'server-bundle.tgz');
  const web = join(root, 'web-assets.tgz');
  const acs = join(selectedDirectory, 'acs-orchestrator.tgz');
  const sbom = join(root, 'sbom.json');
  const runtimeDependencies = join(root, 'runtime-dependencies.json');
  const contract = await loadRuntimeDependencyContract();
  const runtimeIdentity = createRuntimeDependencyIdentity(contract, SHA);
  const acsRuntimeIdentity = createRuntimeDependencyIdentity(contract, BASE);
  await createArchiveWithRuntimeAndUnits(root, server, 'server', runtimeIdentity);
  await createArchiveWithRuntimeAndUnits(root, acs, 'acs-orchestrator', acsRuntimeIdentity);
  await writeFile(web, 'web');
  await writeFile(runtimeDependencies, `${canonicalJson(runtimeIdentity)}\n`);
  await Promise.all([
    cp(server, join(selectedDirectory, 'server-bundle.tgz')),
    cp(web, join(selectedDirectory, 'web-assets.tgz')),
    writeFile(
      join(selectedDirectory, 'runtime-dependencies-server.json'),
      `${canonicalJson(runtimeIdentity)}\n`,
    ),
    writeFile(
      join(selectedDirectory, 'runtime-dependencies-acs.json'),
      `${canonicalJson(acsRuntimeIdentity)}\n`,
    ),
  ]);
  await writeFile(
    sbom,
    `${canonicalJson({
      schemaVersion: 2,
      sourceSha: SHA,
      lockfile: { digest: `sha256:${'a'.repeat(64)}`, size: 1 },
      runtimeDependencies: {
        sourceSha: SHA,
        identityDigest: runtimeIdentity.identityDigest,
        contractDigest: runtimeIdentity.contractDigest,
        dependencyDigest: runtimeIdentity.dependencyDigest,
      },
      packages: [],
    })}\n`,
  );
  const body = {
    schemaVersion: 2,
    sourceSha: SHA,
    artifacts: {
      serverBundle: { path: 'server-bundle.tgz', ...(await digestFile(server)) },
      webAssets: { path: 'web-assets.tgz', ...(await digestFile(web)) },
    },
    sbom: { path: 'sbom.json', ...(await digestFile(sbom)) },
    runtimeDependencies: {
      path: 'runtime-dependencies.json',
      ...(await digestFile(runtimeDependencies)),
      sourceSha: SHA,
      identityDigest: runtimeIdentity.identityDigest,
      contractDigest: runtimeIdentity.contractDigest,
      dependencyDigest: runtimeIdentity.dependencyDigest,
    },
    acsImage: null,
  };
  const index = { ...body, aggregateDigest: digestBuffer(Buffer.from(canonicalJson(body))) };
  const indexPath = join(root, 'artifact-index.json');
  const manifestPath = join(root, 'manifest.json');
  await writeFile(indexPath, JSON.stringify(index));

  const serverArtifact = {
    uri: 'oss://agent-saas-releases/rc-20260826-01/server-bundle.tgz',
    ...index.artifacts.serverBundle,
  };
  delete serverArtifact.path;
  const webArtifact = {
    uri: 'oss://agent-saas-releases/rc-20260826-01/web-assets.tgz',
    ...index.artifacts.webAssets,
  };
  delete webArtifact.path;
  const runtimeArtifact = {
    uri: 'oss://agent-saas-releases/rc-20260826-01/runtime-dependencies.json',
    digest: index.runtimeDependencies.digest,
    size: index.runtimeDependencies.size,
    sourceSha: SHA,
    identityDigest: runtimeIdentity.identityDigest,
    dependencyDigest: runtimeIdentity.dependencyDigest,
    contractDigest: runtimeIdentity.contractDigest,
  };
  const acsFile = await digestFile(acs);
  const acsRuntimeFile = await digestFile(join(selectedDirectory, 'runtime-dependencies-acs.json'));
  const acsRuntimeArtifact = {
    uri: 'oss://agent-saas-releases/baseline/runtime-dependencies.json',
    ...acsRuntimeFile,
    sourceSha: BASE,
    identityDigest: acsRuntimeIdentity.identityDigest,
    dependencyDigest: acsRuntimeIdentity.dependencyDigest,
    contractDigest: acsRuntimeIdentity.contractDigest,
  };
  const productionBaseline = {
    web: { sourceSha: BASE, artifactDigest: BASE_WEB },
    api: { sourceSha: BASE, artifactDigest: `sha256:${'1'.repeat(64)}` },
    runtimeWorker: { sourceSha: BASE, artifactDigest: `sha256:${'1'.repeat(64)}` },
    acs: {
      sourceSha: BASE,
      orchestratorArtifactDigest: acsFile.digest,
      sandboxImageDigest: IMAGE,
    },
  };
  const manifest = signManifest({
    schemaVersion: 2,
    releaseId: 'rc-20260826-01',
    releaseSha: SHA,
    tag: 'rc-20260826-01',
    createdAt: '2026-08-26T00:00:00.000Z',
    createdBy: 'test',
    releasePullRequest: {
      number: 201,
      headSha: 'a'.repeat(40),
      mergeCommitOid: SHA,
      state: 'MERGED',
    },
    integrationCandidates: [],
    sourcePullRequests: [201],
    productionBaseline,
    components: {
      web: { action: 'deploy', sourceSha: SHA, artifactDigest: webArtifact.digest },
      api: { action: 'deploy', sourceSha: SHA, artifactDigest: serverArtifact.digest },
      runtimeWorker: { action: 'deploy', sourceSha: SHA, artifactDigest: serverArtifact.digest },
      acs: { action: 'keep', ...productionBaseline.acs },
    },
    artifacts: {
      serverBundle: serverArtifact,
      webAssets: webArtifact,
      runtimeDependencies: {
        server: runtimeArtifact,
        acs: acsRuntimeArtifact,
      },
      acsOrchestrator: {
        required: false,
        uri: 'oss://agent-saas-releases/baseline/acs-orchestrator.tgz',
        ...acsFile,
      },
      acsImage: { required: false, repository: 'registry/acs', digest: IMAGE },
    },
    checks: {
      appCi: { status: 'success', headSha: SHA, runId: 100 },
      acsImpact: { status: 'not_required', headSha: SHA },
      mergeReceipt: { status: 'success', subjectDigest: `sha256:${'6'.repeat(64)}` },
    },
    promotionPolicy: {
      expiresAt: '2026-08-27T00:00:00.000Z',
      minimumPromotableSha: SHA,
      requiresHumanApproval: true,
    },
    migrationPlan: {
      phase: 'none',
      planDigest: `sha256:${'7'.repeat(64)}`,
      confirmation: 'not_required',
      contract: 'separate_release',
    },
    rollbackTargets: productionBaseline,
  });
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, indexPath, manifestPath, manifest, selectedDirectory };
}

test('publishes one authoritative v2 record with strict artifact index/SBOM v2 idempotently', async () => {
  const value = await fixture();
  const args = {
    manifestPath: value.manifestPath,
    indexPath: value.indexPath,
    recordsRoot: join(value.root, 'records'),
    selectedDirectory: value.selectedDirectory,
  };
  const first = await publishReleaseRecord(args);
  const second = await publishReleaseRecord(args);
  assert.deepEqual(second, first);
  assert.equal(first.manifestDigest, value.manifest.digest);
  await assert.doesNotReject(
    verifyReleaseRecordFiles({
      recordPath: join(value.root, 'records', value.manifest.releaseId, 'record.json'),
      manifestPath: join(value.root, 'records', value.manifest.releaseId, 'manifest.json'),
      indexPath: join(value.root, 'records', value.manifest.releaseId, 'artifact-index.json'),
    }),
  );
});

test('strictly publishes a historical v1 Manifest only with artifact index/SBOM v1', async () => {
  const value = await fixture();
  const sbomPath = join(value.root, 'sbom.json');
  const sbom = JSON.parse(await readFile(sbomPath, 'utf8'));
  sbom.schemaVersion = 1;
  delete sbom.runtimeDependencies;
  await writeFile(sbomPath, `${canonicalJson(sbom)}\n`);

  const index = JSON.parse(await readFile(value.indexPath, 'utf8'));
  index.schemaVersion = 1;
  delete index.runtimeDependencies;
  index.sbom = { path: 'sbom.json', ...(await digestFile(sbomPath)) };
  const { aggregateDigest: _aggregateDigest, ...indexBody } = index;
  index.aggregateDigest = digestBuffer(Buffer.from(canonicalJson(indexBody)));
  await writeFile(value.indexPath, JSON.stringify(index));

  const manifestContent = structuredClone(value.manifest);
  delete manifestContent.digest;
  manifestContent.schemaVersion = 1;
  delete manifestContent.artifacts.runtimeDependencies;
  await writeFile(value.manifestPath, JSON.stringify(signManifest(manifestContent)));

  const record = await publishReleaseRecord({
    manifestPath: value.manifestPath,
    indexPath: value.indexPath,
    recordsRoot: join(value.root, 'records-v1'),
    selectedDirectory: value.selectedDirectory,
  });
  assert.equal(record.releaseId, value.manifest.releaseId);
});

test('rejects a Release record whose canonical Manifest file binding was tampered', async () => {
  const value = await fixture();
  const recordsRoot = join(value.root, 'records-tampered-record');
  await publishReleaseRecord({
    manifestPath: value.manifestPath,
    indexPath: value.indexPath,
    recordsRoot,
    selectedDirectory: value.selectedDirectory,
  });
  const directory = join(recordsRoot, value.manifest.releaseId);
  const recordPath = join(directory, 'record.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  record.manifestFileDigest = `sha256:${'9'.repeat(64)}`;
  await writeFile(recordPath, JSON.stringify(record));
  await assert.rejects(
    verifyReleaseRecordFiles({
      recordPath,
      manifestPath: join(directory, 'manifest.json'),
      indexPath: join(directory, 'artifact-index.json'),
    }),
    /does not bind the exact Manifest and artifact index/u,
  );
});

test('rejects a self-consistent record whose index is semantically unrelated to the Manifest', async () => {
  const value = await fixture();
  const recordsRoot = join(value.root, 'records-unrelated-index');
  await publishReleaseRecord({
    manifestPath: value.manifestPath,
    indexPath: value.indexPath,
    recordsRoot,
    selectedDirectory: value.selectedDirectory,
  });
  const directory = join(recordsRoot, value.manifest.releaseId);
  const indexPath = join(directory, 'artifact-index.json');
  const recordPath = join(directory, 'record.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.artifacts.serverBundle.digest = `sha256:${'8'.repeat(64)}`;
  const { aggregateDigest: _aggregateDigest, ...indexBody } = index;
  index.aggregateDigest = digestBuffer(Buffer.from(canonicalJson(indexBody)));
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  record.artifactDigest = index.aggregateDigest;
  await Promise.all([
    writeFile(indexPath, JSON.stringify(index)),
    writeFile(recordPath, JSON.stringify(record)),
  ]);
  await assert.rejects(
    verifyReleaseRecordFiles({
      recordPath,
      manifestPath: join(directory, 'manifest.json'),
      indexPath,
    }),
    /Release Manifest Server does not match the complete artifact index/u,
  );
});

test('rejects a record that mixes Manifest v2 with artifact index v1', async () => {
  const value = await fixture();
  const recordsRoot = join(value.root, 'records-version-mix');
  await publishReleaseRecord({
    manifestPath: value.manifestPath,
    indexPath: value.indexPath,
    recordsRoot,
    selectedDirectory: value.selectedDirectory,
  });
  const directory = join(recordsRoot, value.manifest.releaseId);
  const indexPath = join(directory, 'artifact-index.json');
  const recordPath = join(directory, 'record.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.schemaVersion = 1;
  delete index.runtimeDependencies;
  const { aggregateDigest: _aggregateDigest, ...indexBody } = index;
  index.aggregateDigest = digestBuffer(Buffer.from(canonicalJson(indexBody)));
  const record = JSON.parse(await readFile(recordPath, 'utf8'));
  record.artifactDigest = index.aggregateDigest;
  await Promise.all([
    writeFile(indexPath, JSON.stringify(index)),
    writeFile(recordPath, JSON.stringify(record)),
  ]);
  await assert.rejects(
    verifyReleaseRecordFiles({
      recordPath,
      manifestPath: join(directory, 'manifest.json'),
      indexPath,
    }),
    /schema versions must match/u,
  );
});

test('rejects a weak object that is not an authoritative Release Manifest', async () => {
  const value = await fixture();
  await writeFile(
    value.manifestPath,
    JSON.stringify({ releaseId: 'rc-20260826-01', releaseSha: SHA }),
  );
  await assert.rejects(
    publishReleaseRecord({
      manifestPath: value.manifestPath,
      indexPath: value.indexPath,
      recordsRoot: join(value.root, 'records-weak'),
      selectedDirectory: value.selectedDirectory,
    }),
  );
});

test('rejects a schema-valid Manifest whose deploy artifact diverges from the complete index', async () => {
  const value = await fixture();
  const content = structuredClone(value.manifest);
  delete content.digest;
  const runtimeIdentity = JSON.parse(
    await readFile(join(value.selectedDirectory, 'runtime-dependencies-server.json'), 'utf8'),
  );
  const selectedServer = join(value.selectedDirectory, 'server-bundle.tgz');
  await createArchiveWithRuntimeAndUnits(
    value.root,
    selectedServer,
    'server',
    runtimeIdentity,
    'changed',
  );
  const changed = await digestFile(selectedServer);
  content.artifacts.serverBundle = {
    ...content.artifacts.serverBundle,
    ...changed,
  };
  content.components.api.artifactDigest = changed.digest;
  content.components.runtimeWorker.artifactDigest = changed.digest;
  await writeFile(value.manifestPath, JSON.stringify(signManifest(content)));
  await assert.rejects(
    publishReleaseRecord({
      manifestPath: value.manifestPath,
      indexPath: value.indexPath,
      recordsRoot: join(value.root, 'records-diverged'),
      selectedDirectory: value.selectedDirectory,
    }),
    /Server does not match the complete artifact index/u,
  );
});

test('rejects a kept component whose selected bytes do not match the Manifest before record publication', async () => {
  const value = await fixture();
  await writeFile(join(value.selectedDirectory, 'acs-orchestrator.tgz'), 'tampered');
  await assert.rejects(
    publishReleaseRecord({
      manifestPath: value.manifestPath,
      indexPath: value.indexPath,
      recordsRoot: join(value.root, 'records-tampered-keep'),
      selectedDirectory: value.selectedDirectory,
    }),
    /Selected acsOrchestrator does not match/u,
  );
});
