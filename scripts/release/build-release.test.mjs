import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProductionBuildPlatform,
  assertProductionRuntimeContract,
  STAGING_SHARED_ASSET_ENTRIES,
  packArgs,
  packRootedArgs,
  productionDeployArgs,
  sbomListArgs,
  sanitizeSbomInventory,
} from './build-release.mjs';
import { loadRuntimeDependencyContract } from './runtime-dependency.mjs';

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

test('SBOM inventory removes host-specific package paths recursively', () => {
  assert.deepEqual(
    sanitizeSbomInventory([
      {
        name: 'server',
        path: '/workspace/checkout/server',
        dependencies: { zod: { version: '4.3.6', path: '/workspace/checkout/node_modules/zod' } },
      },
    ]),
    [{ name: 'server', dependencies: { zod: { version: '4.3.6' } } }],
  );
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

test('production release build requires the exact Node runtime contract', async () => {
  const contract = await loadRuntimeDependencyContract();
  assert.doesNotThrow(() =>
    assertProductionRuntimeContract(contract, {
      version: contract.node.version,
      arch: 'x64',
      platform: 'linux',
    }),
  );
  assert.throws(
    () =>
      assertProductionRuntimeContract(contract, {
        version: '22.23.2',
        arch: 'x64',
        platform: 'linux',
      }),
    /Node version mismatch/u,
  );
});

test('production artifacts require a Linux build host for native dependencies', () => {
  assert.doesNotThrow(() => assertProductionBuildPlatform('linux'));
  assert.throws(
    () => assertProductionBuildPlatform('darwin'),
    /must be built on Linux for native dependencies/u,
  );
});
