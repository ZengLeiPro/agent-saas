import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const removedWorkflowPath = new URL(
  '../../.github/workflows/prepare-release-evidence.yml',
  import.meta.url,
);
const stagingWorkflowPath = new URL('../../.github/workflows/deploy-staging.yml', import.meta.url);
const promotionWorkflowPath = new URL(
  '../../.github/workflows/promote-release.yml',
  import.meta.url,
);

test('Release Evidence is the first isolated stage of manual Staging RC deployment', async () => {
  await assert.rejects(access(removedWorkflowPath), { code: 'ENOENT' });
  const workflow = await readFile(stagingWorkflowPath, 'utf8');
  assert.match(workflow, /workflow_dispatch:[\s\S]*reason:/u);
  assert.doesNotMatch(workflow, /workflow_run:/u);
  assert.match(
    workflow,
    /prepare-evidence:[\s\S]*environment: production[\s\S]*build-deploy-verify:[\s\S]*needs: prepare-evidence[\s\S]*environment: staging/u,
  );
  assert.ok(workflow.indexOf('prepare-evidence:') < workflow.indexOf('build-deploy-verify:'));
  assert.match(workflow, /prepare-evidence:[\s\S]*FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true/u);
  assert.match(workflow, /RELEASE_SHA: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /actions\/workflows\/ci\.yml\/runs/u);
  assert.match(workflow, /head_sha="\$RELEASE_SHA"/u);
  assert.match(workflow, /\.conclusion == "success"/u);
  assert.match(workflow, /commits\/\$RELEASE_SHA\/pulls/u);
  assert.match(workflow, /merge_commit_sha == \$sha/u);
});

test('Staging evidence stage safely reuses or creates one immutable same-SHA record', async () => {
  const workflow = await readFile(stagingWorkflowPath, 'utf8');
  assert.match(workflow, /Reuse immutable Release Evidence when present/u);
  assert.match(workflow, /validateReleaseEvidenceDocument/u);
  assert.match(workflow, /REUSE_RELEASE_EVIDENCE=true/u);
  assert.match(workflow, /acs-classify\.sh/u);
  assert.match(workflow, /actions\/workflows\/acs-sandbox\.yml\/runs/u);
  assert.match(workflow, /workflow: "Build & Check"/u);
  assert.match(workflow, /workflow: "ACS Impact Gate"/u);
  assert.match(workflow, /Read live Production state without mutation/u);
  assert.match(workflow, /RELEASE_RECORD_OSS_URI/u);
  assert.match(workflow, /RELEASE_RECORD_OSS_REGION/u);
  assert.match(workflow, /aliyun --secure oss ls[\s\S]*--region "\$RELEASE_RECORD_OSS_REGION"/u);
  assert.match(workflow, /aliyun --secure oss cp[\s\S]*--region "\$RELEASE_RECORD_OSS_REGION"/u);
  assert.doesNotMatch(workflow, /aliyun --region "\$RELEASE_RECORD_OSS_REGION" --secure/u);
  assert.match(workflow, /resolve-baseline-artifacts\.mjs/u);
  assert.match(workflow, /baseline-artifacts\.json/u);
  assert.match(workflow, /produce-release-evidence\.mjs/u);
  assert.match(workflow, /cat "\$RUNNER_TEMP\/classification\.json" >&2/u);
  assert.match(workflow, /publish-release-evidence\.mjs/u);
  assert.match(workflow, /RELEASE_EVIDENCE_WRITE_TOKEN/u);
  assert.match(workflow, /RELEASE_EVIDENCE_READ_TOKEN/u);
  assert.doesNotMatch(workflow, /compatibility|N\/N\+1/u);
});

test('Staging and Promotion verify component-scoped selected runtime identities', async () => {
  const [staging, promotion] = await Promise.all([
    readFile(stagingWorkflowPath, 'utf8'),
    readFile(promotionWorkflowPath, 'utf8'),
  ]);
  for (const workflow of [staging, promotion]) {
    assert.match(workflow, /runtimeDependencies\.server\.uri/u);
    assert.match(workflow, /runtimeDependencies\.acs\.uri/u);
    assert.match(workflow, /verify-selected-release-artifacts\.mjs/u);
  }
  assert.doesNotMatch(
    promotion,
    /cp "\$RUNNER_TEMP\/release\/artifact-index\.json" "\$RUNNER_TEMP\/selected/u,
  );
});

test('Evidence write identity stays inside the production pre-stage and out of deployment jobs', async () => {
  const [staging, promotion] = await Promise.all([
    readFile(stagingWorkflowPath, 'utf8'),
    readFile(promotionWorkflowPath, 'utf8'),
  ]);
  const deploymentJob = staging.slice(staging.indexOf('  build-deploy-verify:'));
  assert.doesNotMatch(deploymentJob, /RELEASE_EVIDENCE_WRITE_TOKEN/u);
  assert.doesNotMatch(promotion, /RELEASE_EVIDENCE_WRITE_TOKEN/u);
});
