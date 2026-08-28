import assert from 'node:assert/strict';
import test from 'node:test';
import { productionDeployArgs } from './build-release.mjs';

test('production deploy tolerates workspace patches unused by the selected package', () => {
  assert.deepEqual(productionDeployArgs('server', '/tmp/release/server'), [
    '--config.allowUnusedPatches=true',
    '--filter',
    'server',
    '--prod',
    'deploy',
    '--legacy',
    '/tmp/release/server',
  ]);
});
