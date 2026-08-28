import assert from 'node:assert/strict';
import test from 'node:test';
import { packArgs, productionDeployArgs, sbomListArgs } from './build-release.mjs';

test('production deploy tolerates workspace patches unused by the selected package', () => {
  assert.deepEqual(productionDeployArgs('server', '/tmp/release/server'), [
    '--config.allowUnusedPatches=true',
    '--filter',
    'server',
    '--prod',
    'deploy',
    '/tmp/release/server',
  ]);
});

test('SBOM inventory stays bounded while the lockfile digest binds transitive dependencies', () => {
  assert.deepEqual(sbomListArgs(), ['list', '--prod', '--recursive', '--depth', '0', '--json']);
});

test('release archives omit host extended attributes', () => {
  assert.deepEqual(packArgs('/tmp/stage/server', '/tmp/release/server.tgz'), [
    '--no-xattrs',
    '-czf',
    '/tmp/release/server.tgz',
    '-C',
    '/tmp/stage/server',
    '.',
  ]);
});
