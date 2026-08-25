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
  assert.deepEqual(classifyPath('server/src/index.ts').components, ['api']);
  assert.deepEqual(classifyPath('shared/src/types.ts').components, ['web', 'api']);
  assert.deepEqual(classifyPath('workspace-shared/prompts/a.md').components, ['api']);
  assert.deepEqual(classifyPath('hand-server/src/index.ts').components, ['runtimeWorker']);
  assert.deepEqual(classifyPath('acs-orchestrator/src/index.ts').components, ['acs']);
});

test('shared changes conservatively require both web and API deployment', () => {
  const result = classifyChangedPaths(['shared/src/types/ws.ts']);

  assert.deepEqual(result, {
    ok: true,
    changedFiles: ['shared/src/types/ws.ts'],
    components: ['web', 'api'],
    blockingReasons: [],
  });
});

test('unknown paths fail closed while retaining mapped components', () => {
  const result = classifyChangedPaths(['web/src/App.tsx', 'package.json']);

  assert.equal(result.ok, false);
  assert.deepEqual(result.components, ['web']);
  assert.deepEqual(result.blockingReasons, [
    'Changed path is not mapped to a release component: package.json',
  ]);
});

test('reads changed files with git diff --name-only through an injectable executor', () => {
  const calls = [];
  const execFileSync = (...args) => {
    calls.push(args);
    return 'web/src/App.tsx\nacs-orchestrator/src/index.ts\n';
  };

  const paths = readChangedPaths({
    baseline: SHA_A,
    target: SHA_B,
    cwd: '/repo',
    execFileSync,
  });

  assert.deepEqual(paths, ['web/src/App.tsx', 'acs-orchestrator/src/index.ts']);
  assert.deepEqual(calls, [[
    'git',
    ['diff', '--name-only', `${SHA_A}...${SHA_B}`],
    { cwd: '/repo', encoding: 'utf8' },
  ]]);
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
