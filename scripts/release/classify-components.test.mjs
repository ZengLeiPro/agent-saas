import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyChangedPaths,
  classifyComponents,
  classifyPath,
  readChangedPaths,
} from './classify-components.mjs';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

test('classifies each mapped component path', () => {
  assert.deepEqual(classifyPath('web/src/App.tsx').components, ['web']);
  assert.deepEqual(classifyPath('server/src/index.ts').components, ['api', 'runtimeWorker', 'acs']);
  assert.deepEqual(classifyPath('shared/src/types.ts').components, [
    'web',
    'api',
    'runtimeWorker',
    'acs',
  ]);
  assert.deepEqual(classifyPath('workspace-shared/prompts/a.md').components, [
    'api',
    'runtimeWorker',
    'acs',
  ]);
  assert.deepEqual(classifyPath('hand-server/src/index.ts').components, ['api', 'runtimeWorker']);
  assert.deepEqual(classifyPath('acs-orchestrator/src/index.ts').components, ['acs']);
});

test('server changes conservatively require API, runtime worker, and ACS deployment', () => {
  const result = classifyChangedPaths(['server/src/agent/toolRuntime.ts']);

  assert.deepEqual(result, {
    ok: true,
    changedFiles: ['server/src/agent/toolRuntime.ts'],
    components: ['api', 'runtimeWorker', 'acs'],
    blockingReasons: [],
  });
});

test('API and runtime worker stay coupled while they share one server bundle', () => {
  assert.deepEqual(classifyChangedPaths(['hand-server/src/worker.ts']).components, [
    'api',
    'runtimeWorker',
  ]);
});

test('shared changes conservatively require every dependent component deployment', () => {
  const result = classifyChangedPaths(['shared/src/types/ws.ts']);

  assert.deepEqual(result, {
    ok: true,
    changedFiles: ['shared/src/types/ws.ts'],
    components: ['web', 'api', 'runtimeWorker', 'acs'],
    blockingReasons: [],
  });
});

test('classifies root dependency files while explicitly ignoring release-only governance files', () => {
  assert.deepEqual(classifyPath('Dockerfile'), {
    components: ['web', 'api', 'runtimeWorker', 'acs'],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('pnpm-lock.yaml'), {
    components: ['web', 'api', 'runtimeWorker', 'acs'],
    blockingReason: null,
  });
  for (const path of ['Dockerfile', 'config/runtime-dependency-contract.json']) {
    assert.deepEqual(classifyPath(path), {
      components: ['web', 'api', 'runtimeWorker', 'acs'],
      blockingReason: null,
    });
  }
  assert.deepEqual(classifyPath('scripts/release/runtime-dependency.mjs'), {
    components: ['api', 'runtimeWorker', 'acs'],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('scripts/release/artifact-lib.mjs'), {
    components: ['api', 'runtimeWorker', 'acs'],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('scripts/release/preflight.mjs'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('scripts/config/export-effective-config.mjs'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('scripts/staging/render-config.mjs'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('scripts/staging/bootstrap-config.test.mjs'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('e2e/staging/helpers.ts'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('e2e/playwright.config.ts'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(
    classifyPath('daemon-packaging/systemd/agent-saas-server-staging.service.template'),
    {
      components: [],
      blockingReason: null,
    },
  );
  assert.deepEqual(
    classifyPath('daemon-packaging/systemd/agent-saas-runtime-worker-staging.service.template'),
    {
      components: [],
      blockingReason: null,
    },
  );
  assert.deepEqual(classifyPath('scripts/test_acs_operational_scripts.py'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('scripts/format-new-staged-files.mjs'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('scripts/ci-plan.mjs'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('scripts/generate-dws-command-policy.mjs'), {
    components: [],
    blockingReason: null,
  });
  for (const filePath of [
    'scripts/pr-preflight-contract.test.mjs',
    'scripts/pr-preflight-task.sh',
    'scripts/pr-preflight.sh',
  ]) {
    assert.deepEqual(classifyPath(filePath), {
      components: [],
      blockingReason: null,
    });
  }
  assert.deepEqual(classifyPath('scripts/typecheck-staged.mjs'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('docs/release-manifest-v1.md'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('infra/staging/resource-plan.json'), {
    components: [],
    blockingReason: null,
  });
  assert.deepEqual(classifyPath('docs/github配置.md'), {
    components: [],
    blockingReason: null,
  });
});

test('classifies the exact paths that blocked automatic release evidence for PR 371', () => {
  assert.deepEqual(
    classifyChangedPaths([
      'Dockerfile',
      'scripts/pr-preflight-contract.test.mjs',
      'scripts/pr-preflight-task.sh',
      'scripts/pr-preflight.sh',
    ]),
    {
      ok: true,
      changedFiles: [
        'Dockerfile',
        'scripts/pr-preflight-contract.test.mjs',
        'scripts/pr-preflight-task.sh',
        'scripts/pr-preflight.sh',
      ],
      components: ['web', 'api', 'runtimeWorker', 'acs'],
      blockingReasons: [],
    },
  );
});

test('unknown paths fail closed while retaining mapped components', () => {
  const result = classifyChangedPaths(['web/src/App.tsx', 'unmapped-release-input.txt']);

  assert.equal(result.ok, false);
  assert.deepEqual(result.components, ['web']);
  assert.deepEqual(result.blockingReasons, [
    'Changed path is not mapped to a release component: unmapped-release-input.txt',
  ]);
});

test('classifies the six paths from RC run 33944630537 without ignoring unknown scripts', () => {
  for (const filePath of ['scripts/check-max-lines-ratchet.mjs', 'scripts/ratchets.test.mjs']) {
    assert.deepEqual(classifyPath(filePath), { components: [], blockingReason: null });
  }
  assert.deepEqual(classifyPath('scripts/deploy-acs-orchestrator.sh'), {
    components: ['acs'],
    blockingReason: null,
  });
  for (const filePath of [
    'scripts/deploy-recovery-web.sh',
    'scripts/rollback-recovery-web.sh',
    'scripts/rollback-web-oss.sh',
  ]) {
    assert.deepEqual(classifyPath(filePath), { components: ['web'], blockingReason: null });
  }
  assert.equal(classifyChangedPaths(['scripts/unknown-release-input.sh']).ok, false);
});

test('reads changed paths and retains both sides of cross-component renames', () => {
  const calls = [];
  const execFileSync = (...args) => {
    calls.push(args);
    return 'M\tweb/src/App.tsx\nR100\tweb/src/old.ts\tserver/src/new.ts\n';
  };

  const paths = readChangedPaths({
    baseline: SHA_A,
    target: SHA_B,
    cwd: '/repo',
    execFileSync,
  });

  assert.deepEqual(paths, ['web/src/App.tsx', 'web/src/old.ts', 'server/src/new.ts']);
  assert.deepEqual(calls, [
    [
      'git',
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--name-status',
        '--find-renames',
        '--find-copies',
        `${SHA_A}...${SHA_B}`,
      ],
      { cwd: '/repo', encoding: 'utf8' },
    ],
  ]);
});

test('returns blocking JSON-ready data when git diff cannot run', () => {
  const result = classifyComponents({
    baseline: SHA_A,
    target: SHA_B,
    execFileSync: () => {
      throw new Error('not a git repository');
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.components, []);
  assert.match(result.blockingReasons[0], /Unable to read changed paths/u);
});
