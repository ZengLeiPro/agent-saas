import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL(
  '../../.github/workflows/prepare-release-evidence.yml',
  import.meta.url,
);
const stagingWorkflowPath = new URL('../../.github/workflows/deploy-staging.yml', import.meta.url);
const promotionWorkflowPath = new URL(
  '../../.github/workflows/promote-release.yml',
  import.meta.url,
);

test('automatic Evidence Writer runs only after successful main push CI', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(
    workflow,
    /workflow_run:[\s\S]*workflows: \['App CI \/ Deploy'\][\s\S]*types: \[completed\]/u,
  );
  assert.match(workflow, /workflow_run\.conclusion == 'success'/u);
  assert.match(workflow, /workflow_run\.event == 'push'/u);
  assert.match(workflow, /workflow_run\.head_branch == 'main'/u);
  assert.doesNotMatch(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment: production/u);
  assert.match(workflow, /Verify automatic Evidence Writer configuration/u);
  assert.match(
    workflow,
    /permissions:[\s\S]*actions: read[\s\S]*contents: read[\s\S]*pull-requests: read/u,
  );
});

test('automatic Evidence Writer binds independent sources to one immutable SHA', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /github\.event\.workflow_run\.head_sha/u);
  assert.match(workflow, /commits\/\$RELEASE_SHA\/pulls/u);
  assert.match(workflow, /merge_commit_sha == \$sha/u);
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
  assert.match(workflow, /produce-release-evidence\.mjs/u);
  assert.match(workflow, /publish-release-evidence\.mjs/u);
  assert.match(workflow, /RELEASE_EVIDENCE_WRITE_TOKEN/u);
  assert.match(workflow, /RELEASE_EVIDENCE_READ_TOKEN/u);
  assert.doesNotMatch(workflow, /compatibility|N\/N\+1/u);
});

test('Evidence write identity never enters deployment or Production Promotion workflows', async () => {
  const [staging, promotion] = await Promise.all([
    readFile(stagingWorkflowPath, 'utf8'),
    readFile(promotionWorkflowPath, 'utf8'),
  ]);
  assert.doesNotMatch(staging, /RELEASE_EVIDENCE_WRITE_TOKEN/u);
  assert.doesNotMatch(promotion, /RELEASE_EVIDENCE_WRITE_TOKEN/u);
});
