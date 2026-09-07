import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  RELEASE_EVIDENCE_SCHEMA_REVISION,
  RELEASE_EVIDENCE_SCHEMA_VERSION,
} from './release-evidence-schema.mjs';

const workflowPath = new URL(
  '../../.github/workflows/upgrade-evidence-writer.yml',
  import.meta.url,
);
const deployScriptPath = new URL('./deploy-evidence-writer.sh', import.meta.url);

test('Evidence Writer has an isolated, pinned and rollback-capable bootstrap workflow', async () => {
  const [workflow, deployScript] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(deployScriptPath, 'utf8'),
  ]);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /environment: staging/u);
  assert.match(workflow, /STAGING_SSH_HOST_KEY_SHA256/u);
  assert.match(workflow, /ssh-keygen -lf/u);
  assert.match(workflow, /deploy-evidence-writer\.sh/u);
  assert.match(workflow, /releaseEvidenceSchemaRevision/u);
  assert.match(
    workflow,
    new RegExp(`RELEASE_EVIDENCE_SCHEMA_VERSION: '${RELEASE_EVIDENCE_SCHEMA_VERSION}'`, 'u'),
  );
  assert.match(
    workflow,
    new RegExp(`RELEASE_EVIDENCE_SCHEMA_REVISION: '${RELEASE_EVIDENCE_SCHEMA_REVISION}'`, 'u'),
  );
  assert.match(deployScript, /sha256sum/u);
  assert.match(deployScript, /mv -Tf/u);
  assert.match(deployScript, /legacy-before-/u);
  assert.match(deployScript, /restored the previous release/u);
  assert.match(deployScript, /systemctl is-active/u);
  assert.match(deployScript, /127\.0\.0\.1:3420\/capabilities/u);
});
