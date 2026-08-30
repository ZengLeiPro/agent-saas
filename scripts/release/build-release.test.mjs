import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProductionBuildPlatform,
  STAGING_SHARED_ASSET_ENTRIES,
  packArgs,
  packRootedArgs,
  productionDeployArgs,
  sbomListArgs,
} from './build-release.mjs';

test('Staging has a standalone immutable runtime asset allowlist without mutable tenant data', () => {
  assert.ok(STAGING_SHARED_ASSET_ENTRIES.includes('.ky-agent/skills-pool'));
  assert.ok(STAGING_SHARED_ASSET_ENTRIES.includes('prompts'));
  assert.ok(STAGING_SHARED_ASSET_ENTRIES.includes('PERSONA.template.md'));
  assert.ok(!STAGING_SHARED_ASSET_ENTRIES.includes('.ky-agent/settings.json'));
  assert.ok(!STAGING_SHARED_ASSET_ENTRIES.includes('tenants'));
});

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

test('server and ACS release archives retain their component root directory', () => {
  assert.deepEqual(packRootedArgs('/tmp/stage', 'server', '/tmp/release/server.tgz'), [
    '--no-xattrs',
    '-czf',
    '/tmp/release/server.tgz',
    '-C',
    '/tmp/stage',
    'server',
  ]);
  assert.deepEqual(packRootedArgs('/tmp/stage', 'acs-orchestrator', '/tmp/release/acs.tgz'), [
    '--no-xattrs',
    '-czf',
    '/tmp/release/acs.tgz',
    '-C',
    '/tmp/stage',
    'acs-orchestrator',
  ]);
});

test('production artifacts require a Linux build host for native dependencies', () => {
  assert.doesNotThrow(() => assertProductionBuildPlatform('linux'));
  assert.throws(
    () => assertProductionBuildPlatform('darwin'),
    /must be built on Linux for native dependencies/u,
  );
});
