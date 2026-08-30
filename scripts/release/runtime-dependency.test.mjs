import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import {
  createRuntimeDependencyIdentity,
  loadRuntimeDependencyContract,
  runtimeDependencyContractDigest,
  validateRuntimeDependencyContract,
  verifyRuntimeDependencyIdentity,
  verifyRuntimeEnvironment,
} from './runtime-dependency.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

async function fixture() {
  return structuredClone(await loadRuntimeDependencyContract());
}

test('same controlled input produces a stable dependency identity', async () => {
  const contract = await fixture();
  const first = createRuntimeDependencyIdentity(contract, SHA);
  const second = createRuntimeDependencyIdentity(structuredClone(contract), SHA);
  assert.deepEqual(first, second);
  assert.equal(verifyRuntimeDependencyIdentity(first, { sourceSha: SHA }), first);
  const nextRelease = createRuntimeDependencyIdentity(contract, 'b'.repeat(40));
  assert.equal(nextRelease.dependencyDigest, first.dependencyDigest);
  assert.notEqual(nextRelease.identityDigest, first.identityDigest);
});

test('runtime, image, and tool upgrades produce auditable identity changes', async () => {
  const contract = await fixture();
  const baseline = createRuntimeDependencyIdentity(contract, SHA).dependencyDigest;
  for (const mutate of [
    (value) => {
      value.node.version = '22.23.2';
    },
    (value) => {
      value.baseImages[0].reference = `docker.io/library/node@${DIGEST}`;
    },
    (value) => {
      value.tools[0].version = '2.49.2';
    },
  ]) {
    const changed = structuredClone(contract);
    mutate(changed);
    assert.notEqual(createRuntimeDependencyIdentity(changed, SHA).dependencyDigest, baseline);
  }
});

test('mutable or missing image identities fail closed', async () => {
  const contract = await fixture();
  contract.baseImages[0].reference = 'docker.io/library/node:22-alpine';
  assert.throws(() => validateRuntimeDependencyContract(contract), /immutable registry digest/u);
  delete contract.baseImages[0].reference;
  assert.throws(() => validateRuntimeDependencyContract(contract), /fields must be exactly/u);
});

test('identity tampering and Admin Runner contract conflicts are rejected', async () => {
  const contract = await fixture();
  const identity = createRuntimeDependencyIdentity(contract, SHA);
  identity.node.version = '22.23.2';
  assert.throws(() => verifyRuntimeDependencyIdentity(identity), /dependency digest mismatch/u);

  const clean = createRuntimeDependencyIdentity(contract, SHA);
  assert.throws(
    () => verifyRuntimeDependencyIdentity(clean, { contractDigest: DIGEST }),
    /conflicts with the expected release contract/u,
  );
});

test('exact Node version, architecture, and required tools are enforced', async () => {
  const contract = await fixture();
  const identity = createRuntimeDependencyIdentity(contract, SHA);
  const runtime = { version: contract.node.version, arch: 'x64', platform: 'linux' };
  const execFileSync = (command) =>
    `${command} version ${contract.tools.find((tool) => tool.probe[0] === command).version}\n`;
  assert.equal(
    verifyRuntimeEnvironment({ identity, component: 'server', runtime, execFileSync })
      .dependencyDigest,
    identity.dependencyDigest,
  );
  assert.throws(
    () =>
      verifyRuntimeEnvironment({
        identity,
        component: 'server',
        runtime: { ...runtime, version: '22.23.2' },
        checkTools: false,
      }),
    /Node version mismatch/u,
  );
  assert.throws(
    () =>
      verifyRuntimeEnvironment({
        identity,
        component: 'server',
        runtime: { ...runtime, arch: 'arm64' },
        checkTools: false,
      }),
    /Node architecture mismatch/u,
  );
  assert.throws(
    () =>
      verifyRuntimeEnvironment({
        identity,
        component: 'server',
        runtime,
        execFileSync: () => {
          throw new Error('missing');
        },
      }),
    /tool git is missing/u,
  );
  for (const misleadingVersion of [
    'git version 0.0.0',
    'git version 2.49.1+',
    'git version 12.49.10',
    'git version 2.49.1.1',
    'git version 2.49.1-custom',
    'git version 2.49.1rc1',
    'git version 2.49.1-',
    'git version v2.49.1',
    'git version 99.0.0 (compatibility 2.49.1)',
    'git version v99.0.0 (compatibility 2.49.1)',
  ]) {
    assert.throws(
      () =>
        verifyRuntimeEnvironment({
          identity,
          component: 'server',
          runtime,
          execFileSync: () => misleadingVersion,
        }),
      /tool git version mismatch/u,
    );
  }
});

test('ACS Sandbox verifies the git version installed by the base image build', async () => {
  const contract = await fixture();
  const identity = createRuntimeDependencyIdentity(contract, SHA);
  const runtime = { version: contract.node.version, arch: 'x64', platform: 'linux' };
  const execFileSync = (command) => {
    const tool = contract.tools.find(
      (entry) => entry.probe[0] === command && entry.components.includes('acsSandbox'),
    );
    return `${command} version ${tool.version}\n`;
  };
  assert.doesNotThrow(() =>
    verifyRuntimeEnvironment({
      identity,
      component: 'acsSandbox',
      runtime,
      execFileSync,
    }),
  );
  assert.throws(
    () =>
      verifyRuntimeEnvironment({
        identity,
        component: 'acsSandbox',
        runtime,
        execFileSync: (command, args) =>
          command === 'git' ? 'git version 2.39.4' : execFileSync(command, args),
      }),
    /tool git version mismatch/u,
  );
});

test('Docker and systemd production paths consume the pinned identity and startup guard', async () => {
  const contract = await fixture();
  const dockerfile = await readFile('Dockerfile', 'utf8');
  for (const image of contract.baseImages) {
    assert.ok(dockerfile.includes(image.reference.split('@')[1]));
  }
  assert.doesNotMatch(dockerfile, /^FROM .*:(?:22|3\.12)[^@\n]*$/gmu);
  const units = [
    ['daemon-packaging/systemd/agent-saas-server@.service.template', 'server'],
    ['daemon-packaging/systemd/agent-saas-runtime-worker@.service.template', 'runtimeWorker'],
    ['daemon-packaging/systemd/agent-saas-acs-orchestrator.service.template', 'acsOrchestrator'],
  ];
  for (const [path, component] of units) {
    const body = await readFile(path, 'utf8');
    assert.match(
      body,
      new RegExp(
        `ExecStartPre=/usr/bin/node .*runtime-dependency\\.mjs .*--component=${component}`,
      ),
    );
  }
});

test('every production flag form forbids disabling runtime dependency checks', () => {
  const createBypass = spawnSync(
    process.execPath,
    ['scripts/release/runtime-dependency.mjs', '--create=true', '--production', '--mode=off'],
    { encoding: 'utf8' },
  );
  assert.notEqual(createBypass.status, 0);
  assert.match(createBypass.stderr, /cannot be disabled/u);

  for (const productionFlag of [
    '--production=true',
    '--production=1',
    '--production=yes',
    '--production',
  ]) {
    const result = spawnSync(
      process.execPath,
      ['scripts/release/runtime-dependency.mjs', productionFlag, '--mode=off'],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /cannot be disabled/u);
  }
});

test('contract rejects secret-like fields, sensitive values, and unbounded probes', async () => {
  const contract = await fixture();
  contract.secretToken = 'should-never-ship';
  assert.throws(() => runtimeDependencyContractDigest(contract), /is sensitive/u);

  for (const invalidVersion of ['01.2.3', '1.2.3-a..b']) {
    const withInvalidVersion = await fixture();
    withInvalidVersion.tools[0].version = invalidVersion;
    assert.throws(
      () => validateRuntimeDependencyContract(withInvalidVersion),
      /normalized name and exact version/u,
    );
  }

  const withUnsupportedImageComponent = await fixture();
  withUnsupportedImageComponent.baseImages[0].components.push('secret-vault');
  assert.throws(
    () => validateRuntimeDependencyContract(withUnsupportedImageComponent),
    /baseImage\.node-alpine\.components contains unsupported value/u,
  );

  for (const probe of [
    ['/home/operator/bin/git', '--version'],
    ['/root/.ssh/id_rsa', '--version'],
    ['/tmp/git', '--version'],
    ['git', '--version', 'Authorization: Bearer secret-value'],
    ['git', 'Authorization: Bearer secret-value'],
    ['git', '--exec-path=/tmp/tools'],
    ['arbitrary-helper', '--version'],
  ]) {
    const withProbe = await fixture();
    withProbe.tools[0].probe = probe;
    assert.throws(
      () => validateRuntimeDependencyContract(withProbe),
      /sensitive or host-specific data|supported fixed version probe/u,
    );
  }
});
