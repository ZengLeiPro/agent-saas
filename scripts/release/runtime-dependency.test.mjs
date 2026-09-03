import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  createRuntimeDependencyIdentity,
  loadRuntimeDependencyContract,
  runtimeDependencyContractDigest,
  runtimeEnvironmentFromSystemdEnvironmentFile,
  validateRuntimeDependencyContract,
  verifyRuntimeDependencyIdentity,
  verifyRuntimeEnvironment,
} from './runtime-dependency.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const ACS_SANDBOX_TOOL_VERSION_ARGUMENTS = Object.freeze({
  git: 'ACS_GIT_VERSION',
  python: 'ACS_PYTHON_VERSION',
  gh: 'GH_CLI_VERSION',
  aliyun: 'ALIYUN_CLI_VERSION',
  gws: 'GWS_CLI_VERSION',
  ntn: 'NTN_CLI_VERSION',
  bird: 'BIRD_CLI_VERSION',
  dws: 'DWS_CLI_VERSION',
  'lark-cli': 'LARK_CLI_VERSION',
});
const ACS_SANDBOX_TOOL_INSTALLER_PATTERNS = Object.freeze({
  git: /test "\$\(git --version\)" = "git version \$\{ACS_GIT_VERSION\}"/u,
  python: /test "\$\(python3 --version\)" = "Python \$\{ACS_PYTHON_VERSION\}"/u,
  gh: /releases\/download\/v\$\{GH_CLI_VERSION\}\/gh_\$\{GH_CLI_VERSION\}_linux_amd64/u,
  aliyun: /aliyun-cli-linux-\$\{ALIYUN_CLI_VERSION\}-amd64\.tgz/u,
  gws: /release_url="https:\/\/github\.com\/googleworkspace\/cli\/releases\/download\/v\$\{GWS_CLI_VERSION\}"/u,
  ntn: /npm install -g "ntn@\$\{NTN_CLI_VERSION\}"[\s\S]*?ntn --version/u,
  bird: /npm install -g "@steipete\/bird@\$\{BIRD_CLI_VERSION\}"[\s\S]*?bird --version/u,
  dws: /npm install -g "dingtalk-workspace-cli@\$\{DWS_CLI_VERSION\}"[\s\S]*?dws --version/u,
  'lark-cli': /npm install -g "@larksuite\/cli@\$\{LARK_CLI_VERSION\}"[\s\S]*?lark-cli --version/u,
});

function assertAcsSandboxDockerToolMatrix(dockerfile, contract) {
  const tools = contract.tools.filter((tool) => tool.components.includes('acsSandbox'));
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    Object.keys(ACS_SANDBOX_TOOL_VERSION_ARGUMENTS).sort(),
    'every ACS Sandbox Runtime tool must have one Docker version source',
  );

  for (const tool of tools) {
    const argument = ACS_SANDBOX_TOOL_VERSION_ARGUMENTS[tool.name];
    const versionMatch = dockerfile.match(new RegExp(`^ARG ${argument}=([^\\s]+)$`, 'mu'));
    assert.ok(versionMatch, `${tool.name} Docker version ARG is missing`);
    assert.equal(
      versionMatch[1],
      tool.version,
      `${tool.name} Docker version ARG must match the Runtime contract`,
    );
    assert.match(
      dockerfile,
      ACS_SANDBOX_TOOL_INSTALLER_PATTERNS[tool.name],
      `${tool.name} installer must consume its Docker version ARG and run a version smoke`,
    );
  }
}

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

test('mutable, missing, or malformed image identities fail closed', async () => {
  const contract = await fixture();
  for (const reference of [
    'docker.io/library/node:22-alpine',
    `:@${DIGEST}`,
    `.../@${DIGEST}`,
    `/library/node@${DIGEST}`,
  ]) {
    const invalid = structuredClone(contract);
    invalid.baseImages[0].reference = reference;
    assert.throws(() => validateRuntimeDependencyContract(invalid), /immutable registry digest/u);
  }
  delete contract.baseImages[0].reference;
  assert.throws(() => validateRuntimeDependencyContract(contract), /fields must be exactly/u);
});

test('Runtime contract collections require canonical order instead of producing false identity drift', async () => {
  const contract = await fixture();
  const baseline = runtimeDependencyContractDigest(contract);
  assert.equal(runtimeDependencyContractDigest(structuredClone(contract)), baseline);

  const reorderedTools = structuredClone(contract);
  reorderedTools.tools.reverse();
  assert.throws(
    () => runtimeDependencyContractDigest(reorderedTools),
    /tools must use the canonical supported order/u,
  );

  const reorderedComponents = structuredClone(contract);
  reorderedComponents.node.components.reverse();
  assert.throws(
    () => runtimeDependencyContractDigest(reorderedComponents),
    /node.components must use the canonical supported order/u,
  );
});

test('contract ownership matrix cannot drop a Runtime component, base image, or required tool', async () => {
  const contract = await fixture();
  for (const [label, mutate] of [
    [
      'Node component',
      (value) => {
        value.node.components.pop();
      },
    ],
    [
      'base image',
      (value) => {
        value.baseImages.pop();
      },
    ],
    [
      'required tool',
      (value) => {
        value.tools.splice(
          value.tools.findIndex(
            (tool) => tool.name === 'kubectl' && tool.components.includes('acsOrchestrator'),
          ),
          1,
        );
      },
    ],
    [
      'conditional required tool',
      (value) => {
        value.tools.splice(
          value.tools.findIndex(
            (tool) => tool.name === 'aliyun' && tool.components.includes('acsOrchestrator'),
          ),
          1,
        );
      },
    ],
  ]) {
    const weakened = structuredClone(contract);
    mutate(weakened);
    assert.throws(
      () => createRuntimeDependencyIdentity(weakened, SHA),
      /complete supported ownership matrix/u,
      label,
    );
  }
});

test('identity tampering and Admin Runner contract digest conflicts are rejected', async () => {
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

test('exact Node version, architecture, and required tool versions are enforced', async () => {
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
    'git version 2.52.0+',
    'git version 12.52.10',
    'git version 2.52.0.1',
    'git version 2.52.0-custom',
    'git version 2.52.0rc1',
    'git version 2.52.0-',
    'git version v2.52.0',
    'git version 99.0.0 (compatibility 2.52.0)',
    'git version v99.0.0 (compatibility 2.52.0)',
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

test('ACS Sandbox accepts the dws CLI v-prefixed semantic version', async () => {
  const contract = await fixture();
  const identity = createRuntimeDependencyIdentity(contract, SHA);
  const runtime = { version: contract.node.version, arch: 'x64', platform: 'linux' };
  const execFileSync = (command) => {
    const tool = contract.tools.find(
      (entry) => entry.probe[0] === command && entry.components.includes('acsSandbox'),
    );
    return command === 'dws'
      ? `dws version v${tool.version} (build metadata)\n`
      : `${command} version ${tool.version}\n`;
  };

  assert.doesNotThrow(() =>
    verifyRuntimeEnvironment({
      identity,
      component: 'acsSandbox',
      runtime,
      execFileSync,
    }),
  );
});

test('systemd EnvironmentFile parsing is non-executing and clears inherited Runtime selectors', () => {
  const environment = runtimeEnvironmentFromSystemdEnvironmentFile(
    [
      '  # comment',
      'ACS_KUBECTL_PATH="/managed/kubectl custom"',
      "ACS_ALIYUN_CLI_PATH='/managed/aliyun'",
      'ACS_SNAT_MODE=$(touch /tmp/runtime-dependency-injection)',
    ].join('\n'),
    {
      ACS_KUBECTL_PATH: '/stale/kubectl',
      ACS_ALIYUN_CLI_PATH: '/stale/aliyun',
      ACS_SNAT_MODE: 'disabled',
      SAFE_UNRELATED_VALUE: 'retained',
    },
  );
  assert.equal(environment.ACS_KUBECTL_PATH, '/managed/kubectl custom');
  assert.equal(environment.ACS_ALIYUN_CLI_PATH, '/managed/aliyun');
  assert.equal(environment.ACS_SNAT_MODE, '$(touch /tmp/runtime-dependency-injection)');
  assert.equal(environment.SAFE_UNRELATED_VALUE, 'retained');

  const defaults = runtimeEnvironmentFromSystemdEnvironmentFile('', {
    ACS_KUBECTL_PATH: '/stale/kubectl',
    ACS_ALIYUN_CLI_PATH: '/stale/aliyun',
    ACS_SNAT_MODE: 'shared-cidr',
  });
  assert.equal(defaults.ACS_KUBECTL_PATH, undefined);
  assert.equal(defaults.ACS_ALIYUN_CLI_PATH, undefined);
  assert.equal(defaults.ACS_SNAT_MODE, undefined);
  assert.throws(
    () => runtimeEnvironmentFromSystemdEnvironmentFile('ACS_SNAT_MODE="shared-cidr'),
    /unterminated quote/u,
  );

  const continued = runtimeEnvironmentFromSystemdEnvironmentFile(
    [
      '# a standalone comment ending in \\ must not consume the next assignment\\',
      'ACS_KUBECTL_PATH="/managed/\\',
      'kubectl"',
      'ACS_ALIYUN_CLI_PATH=/managed/\\',
      '# a continued comment must not terminate the assignment',
      'aliyun',
      'ACS_SNAT_MODE=shared-cidr',
    ].join('\n'),
  );
  assert.equal(continued.ACS_KUBECTL_PATH, '/managed/ kubectl');
  assert.equal(continued.ACS_ALIYUN_CLI_PATH, '/managed/ aliyun');
  assert.equal(continued.ACS_SNAT_MODE, 'shared-cidr');
  assert.throws(
    () => runtimeEnvironmentFromSystemdEnvironmentFile('ACS_SNAT_MODE=shared-\\'),
    /dangling continuation/u,
  );
});

test('systemd EnvironmentFile CLI emits NUL-delimited values without executing shell syntax', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-dependency-environment-'));
  const marker = join(root, 'injected');
  const environmentFile = join(root, 'acs.env');
  writeFileSync(
    environmentFile,
    `ACS_ORCH_AUTH_TOKEN=$(touch ${marker})\nACS_NAMESPACE=agent-saas-coding\n`,
  );
  try {
    const result = spawnSync(process.execPath, [
      'scripts/release/runtime-dependency.mjs',
      `--environment-file=${environmentFile}`,
      '--print-environment=ACS_ORCH_AUTH_TOKEN,ACS_NAMESPACE',
    ]);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.deepEqual(
      result.stdout,
      Buffer.from(`ACS_ORCH_AUTH_TOKEN\0$(touch ${marker})\0ACS_NAMESPACE\0agent-saas-coding\0`),
    );
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ACS Orchestrator fails closed on kubectl and conditionally probes the configured aliyun CLI', async () => {
  const contract = await fixture();
  const identity = createRuntimeDependencyIdentity(contract, SHA);
  const runtime = { version: contract.node.version, arch: 'x64', platform: 'linux' };

  assert.throws(
    () =>
      verifyRuntimeEnvironment({
        identity,
        component: 'acsOrchestrator',
        runtime,
        environment: { ACS_SNAT_MODE: 'disabled' },
        execFileSync: () => {
          throw new Error('missing');
        },
      }),
    /tool git is missing/u,
  );
  assert.throws(
    () =>
      verifyRuntimeEnvironment({
        identity,
        component: 'acsOrchestrator',
        runtime,
        environment: { ACS_SNAT_MODE: 'disabled' },
        execFileSync: (command) =>
          command === 'git' ? 'git version 2.52.0' : 'Client Version: v1.36.9',
      }),
    /tool kubectl version mismatch/u,
  );

  const disabledCalls = [];
  assert.doesNotThrow(() =>
    verifyRuntimeEnvironment({
      identity,
      component: 'acsOrchestrator',
      runtime,
      environment: runtimeEnvironmentFromSystemdEnvironmentFile(
        'ACS_SNAT_MODE=disabled\nACS_KUBECTL_PATH=/managed/kubectl\nACS_ALIYUN_CLI_PATH=/managed/aliyun\n',
      ),
      execFileSync: (command, args) => {
        disabledCalls.push([command, args]);
        return command === 'git' ? 'git version 2.52.0' : 'Client Version: v1.37.0';
      },
    }),
  );
  assert.deepEqual(disabledCalls, [
    ['git', ['--version']],
    ['/managed/kubectl', ['version', '--client=true']],
  ]);

  const enabledCalls = [];
  assert.doesNotThrow(() =>
    verifyRuntimeEnvironment({
      identity,
      component: 'acsOrchestrator',
      runtime,
      environment: runtimeEnvironmentFromSystemdEnvironmentFile(
        'ACS_SNAT_MODE=shared-cidr\nACS_KUBECTL_PATH=/managed/kubectl\nACS_ALIYUN_CLI_PATH=/managed/aliyun\n',
      ),
      execFileSync: (command, args) => {
        enabledCalls.push([command, args]);
        if (command === 'git') return 'git version 2.52.0';
        return command.endsWith('kubectl') ? 'Client Version: v1.37.0' : '3.4.4';
      },
    }),
  );
  assert.deepEqual(enabledCalls, [
    ['git', ['--version']],
    ['/managed/kubectl', ['version', '--client=true']],
    ['/managed/aliyun', ['version']],
  ]);
  for (const [label, aliyunProbe] of [
    [
      'missing',
      () => {
        throw new Error('missing');
      },
    ],
    ['drifted', () => '3.4.3'],
  ]) {
    assert.throws(
      () =>
        verifyRuntimeEnvironment({
          identity,
          component: 'acsOrchestrator',
          runtime,
          environment: runtimeEnvironmentFromSystemdEnvironmentFile(
            'ACS_SNAT_MODE=shared-cidr\nACS_KUBECTL_PATH=/managed/kubectl\nACS_ALIYUN_CLI_PATH=/managed/aliyun\n',
          ),
          execFileSync: (command) => {
            if (command === 'git') return 'git version 2.52.0';
            if (command === '/managed/kubectl') return 'Client Version: v1.37.0';
            return aliyunProbe();
          },
        }),
      label === 'missing' ? /tool aliyun is missing/u : /tool aliyun version mismatch/u,
    );
  }
  assert.throws(
    () =>
      verifyRuntimeEnvironment({
        identity,
        component: 'acsOrchestrator',
        runtime,
        environment: { ACS_SNAT_MODE: 'probe-only' },
        execFileSync: (command) => {
          if (command === 'git') return 'git version 2.52.0';
          if (command === 'kubectl') return 'Client Version: v1.37.0';
          throw new Error('missing');
        },
      }),
    /tool aliyun is missing/u,
  );
});

test('ACS Sandbox Docker tool versions stay synchronized with the Runtime contract', async () => {
  const contract = await fixture();
  const dockerfile = await readFile('Dockerfile', 'utf8');
  assertAcsSandboxDockerToolMatrix(dockerfile, contract);

  const driftedDockerfile = dockerfile.replace(
    'ARG DWS_CLI_VERSION=1.0.60',
    'ARG DWS_CLI_VERSION=1.0.61',
  );
  assert.throws(
    () => assertAcsSandboxDockerToolMatrix(driftedDockerfile, contract),
    /dws Docker version ARG must match the Runtime contract/u,
  );
});

test('Docker tool versions and systemd production paths consume the pinned identity and startup guard', async () => {
  const contract = await fixture();
  const dockerfile = await readFile('Dockerfile', 'utf8');
  for (const image of contract.baseImages) {
    assert.ok(dockerfile.includes(image.reference.split('@')[1]));
  }
  assert.doesNotMatch(dockerfile, /^FROM .*:(?:22|3\.12)[^@\n]*$/gmu);
  assert.match(dockerfile, /test "\$\(git --version\)" = "git version 2\.49\.1"/u);
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

test('contract rejects missing Runtime bindings, sensitive values, unbounded probes, and forged conditions', async () => {
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

  const missingExecutableBinding = await fixture();
  delete missingExecutableBinding.tools.find(
    (tool) => tool.name === 'kubectl' && tool.components.includes('acsOrchestrator'),
  ).executableEnvironment;
  assert.throws(
    () => validateRuntimeDependencyContract(missingExecutableBinding),
    /unsupported executable environment binding/u,
  );

  const missingCondition = await fixture();
  delete missingCondition.tools.find(
    (tool) => tool.name === 'aliyun' && tool.components.includes('acsOrchestrator'),
  ).when;
  assert.throws(
    () => validateRuntimeDependencyContract(missingCondition),
    /must declare its optional Runtime condition/u,
  );

  const forgedCondition = await fixture();
  const conditionalTool = forgedCondition.tools.find(
    (tool) => tool.name === 'aliyun' && tool.components.includes('acsOrchestrator'),
  );
  conditionalTool.when.environment = 'ARBITRARY_MODE';
  assert.throws(
    () => validateRuntimeDependencyContract(forgedCondition),
    /unsupported runtime condition/u,
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
