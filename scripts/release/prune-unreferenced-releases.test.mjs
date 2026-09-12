import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const helper = resolve('scripts/release/prune-unreferenced-releases.sh');
const helperTest = resolve('scripts/release/prune-unreferenced-releases.test.sh');
const staging = resolve('scripts/release/deploy-staging-release.sh');
const production = resolve('scripts/release/deploy-production-release.sh');
const recovery = resolve('scripts/deploy-recovery-web.sh');

test('prune helper unit tests pass', () => {
  const result = spawnSync('bash', [helperTest], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('staging prunes only after a committed deploy and not on rollback', async () => {
  const source = await readFile(staging, 'utf8');
  assert.match(source, /source "\$\(dirname "\$0"\)\/prune-unreferenced-releases\.sh"/);
  const committed = source.indexOf('deployment_committed=true');
  const prune = source.indexOf('prune_unreferenced_release_dirs');
  const rollback = source.indexOf('rollback() {');
  assert.ok(committed > 0 && prune > committed, 'staging prune must run after commit');
  assert.ok(rollback > 0 && prune > rollback, 'rollback is defined before prune call');
  const rollbackBlock = source.slice(rollback, source.indexOf('\nfinish() {', rollback));
  assert.doesNotMatch(rollbackBlock, /prune_unreferenced_release_dirs/);
  assert.match(source, /ln -sfn "\$previous" "\$root\/previous"/);
});

test('production prunes App idle-color digests in and ACS previous after commit', async () => {
  const source = await readFile(production, 'utf8');
  assert.match(source, /source "\$_prune_helper"/);
  const appCommitted = source.lastIndexOf('app_committed=true');
  const acsCommitted = source.indexOf('acs_committed=true');
  const appPrune = source.indexOf('prune_unreferenced_release_dirs "$app_releases_root"');
  const acsPrune = source.indexOf('prune_unreferenced_release_dirs "$acs_releases_root"');
  assert.ok(appCommitted > 0 && appPrune > appCommitted, 'app prune after commit');
  assert.ok(acsCommitted > 0 && acsPrune > acsCommitted, 'acs prune after commit');
  const appRollback = source.slice(
    source.indexOf('rollback_app_release() {'),
    source.indexOf('\ncleanup_app_failure() {'),
  );
  const acsRollback = source.slice(
    source.indexOf('rollback_acs_release() {'),
    source.indexOf('\ncleanup_acs_failure() {'),
  );
  assert.doesNotMatch(appRollback, /prune_unreferenced_release_dirs/);
  assert.doesNotMatch(acsRollback, /prune_unreferenced_release_dirs/);
});

test('web recovery prunes unreferenced releases after activation and keeps current/previous', async () => {
  const source = await readFile(recovery, 'utf8');
  assert.match(source, /source "\$\(dirname "\$0"\)\/release\/prune-unreferenced-releases\.sh"/);
  assert.match(source, /declare -F prune_unreferenced_release_dirs/);
  const activated = source.indexOf('write_receipt activated');
  const prune = source.indexOf('prune_unreferenced_release_dirs "$RELEASES_DIR"');
  assert.ok(activated > 0 && prune > activated, 'web prune after activation');
  assert.match(source, /prune_unreferenced_files_matching_keep_ids "\$ARTIFACTS_DIR"/);
});

test('helper itself refuses symlink children and empty keep sets', async () => {
  const source = await readFile(helper, 'utf8');
  assert.match(source, /refuse to prune release symlink/);
  assert.match(source, /at least one keep path/);
  assert.doesNotMatch(source, /ls -dt/);
  assert.doesNotMatch(source, /newest 4/);
});

test('staging and promotion workflows ship the prune helper with the deploy scripts', async () => {
  const stagingWorkflow = await readFile(resolve('.github/workflows/deploy-staging.yml'), 'utf8');
  const promotionWorkflow = await readFile(resolve('.github/workflows/promote-release.yml'), 'utf8');
  assert.match(stagingWorkflow, /scripts\/release\/prune-unreferenced-releases\.sh/);
  assert.match(promotionWorkflow, /scripts\/release\/prune-unreferenced-releases\.sh/);
  assert.match(
    promotionWorkflow,
    /cat scripts\/release\/prune-unreferenced-releases\.sh scripts\/deploy-recovery-web\.sh/,
  );
});
