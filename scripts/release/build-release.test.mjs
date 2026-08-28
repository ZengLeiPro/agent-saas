import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProductionBuildPlatform,
  packArgs,
  productionDeployArgs,
  sbomListArgs,
} from './build-release.mjs';

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

test('production artifacts require a Linux build host for native dependencies', () => {
  assert.doesNotThrow(() => assertProductionBuildPlatform('linux'));
  assert.throws(
    () => assertProductionBuildPlatform('darwin'),
    /must be built on Linux for native dependencies/u,
  );
});
