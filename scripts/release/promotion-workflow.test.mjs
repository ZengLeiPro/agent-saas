import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../../.github/workflows/promote-release.yml', import.meta.url);
const deployPath = new URL('./deploy-production-release.sh', import.meta.url);

function ordered(text, markers) {
  let cursor = -1;
  for (const marker of markers) {
    const next = text.indexOf(marker);
    assert.ok(next > cursor, `${marker} must appear in the required order`);
    cursor = next;
  }
}

test('promotion accepts only an approved release id and serializes production mutation', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /release_id:/u);
  assert.doesNotMatch(workflow, /^\s+(?:release_sha|artifact_url|image_tag):/mu);
  assert.match(workflow, /group: production-promotion/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /PRODUCTION_SSH_HOST_KEY_SHA256/u);
  assert.match(workflow, /Latest release attestation is not approved|--state approved/u);
  assert.match(workflow, /deployments\/\$deployment_id\/statuses/u);
  assert.match(workflow, /actions\/runs\/\$e2e_run_id/u);
});

test('all validation and prefetch precede mutation, then ACS, App, and Web converge in order', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  ordered(workflow, [
    '- name: Read authoritative production baseline before any write',
    '- name: Prefetch and verify all selected artifacts',
    '- name: Mark promotion started',
    '- name: Upload immutable deploy payload and managed units',
    '- name: Deploy exact ACS Orchestrator and Sandbox digest first',
    '- name: Deploy API blue-green and hand off Runtime Worker',
    '- name: Publish Web entry last and retain prior hashed assets',
  ]);
  assert.match(workflow, /components\.acs\.sandboxImageDigest/u);
  assert.match(workflow, /aliyun cr ListRepoTag/u);
  assert.match(workflow, /sha256sum/u);
  assert.match(workflow, /release-identity\.json/u);
  assert.match(workflow, /keep without restart/u);
});

test('workflow preserves partial matrices, rollback evidence, migrations, and observation boundaries', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const deploy = await readFile(deployPath, 'utf8');
  assert.match(workflow, /read-live-production-components\.mjs/u);
  assert.match(workflow, /target_match=false/u);
  assert.match(workflow, /write-production-identity\.mjs/u);
  assert.match(workflow, /duration-ms 900000/u);
  assert.match(workflow, /separate_release/u);
  assert.match(workflow, /compatibilityEvidenceDigest/u);
  assert.match(workflow, /confirmed_after_observation/u);
  assert.match(workflow, /contractExecuted:false/u);
  assert.match(workflow, /restore_web_entry/u);
  assert.match(deploy, /cleanup_app_failure/u);
  assert.match(deploy, /api_switched=true/u);
  assert.match(deploy, /exit 20/u);
  assert.doesNotMatch(deploy, /pnpm (?:install|build)/u);
  execFileSync('bash', ['-n', deployPath.pathname]);
});
