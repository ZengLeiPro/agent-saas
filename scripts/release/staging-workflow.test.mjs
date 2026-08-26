import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../../.github/workflows/deploy-staging.yml', import.meta.url);
const deployPath = new URL('./deploy-staging-release.sh', import.meta.url);
const resourcePath = new URL('../../infra/staging/resource-plan.json', import.meta.url);

test('Staging workflow accepts only a reason and locks the dispatch SHA and single slot', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /workflow_dispatch:[\s\S]*reason:/u);
  assert.doesNotMatch(workflow, /release_sha:/u);
  assert.match(workflow, /group: staging-deploy\s+cancel-in-progress: false/u);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/u);
  assert.match(workflow, /environment: staging/u);
  assert.match(workflow, /REUSE_RC=true/u);
  assert.match(workflow, /state staging_deployed/u);
  assert.match(workflow, /state verified/u);
});

test('target deployment consumes bundles without source install/build and uses only Staging paths', async () => {
  const deploy = await readFile(deployPath, 'utf8');
  assert.doesNotMatch(deploy, /pnpm (install|build)|npm (install|run)/u);
  assert.doesNotMatch(deploy, /\/opt\/agent-saas-app|agent-saas-server@|active-color/u);
  assert.match(deploy, /\/opt\/agent-saas-staging/u);
  assert.match(deploy, /agent-saas-acs-orchestrator-staging\.service/u);
  assert.match(deploy, /kill -USR2/u);
  assert.match(deploy, /orchestratorArtifactDigest/u);
  assert.match(deploy, /sandboxImageDigest/u);
});

test('resource plan is fail-closed until every isolated cloud identity is assigned', async () => {
  const plan = JSON.parse(await readFile(resourcePath, 'utf8'));
  assert.equal(plan.environment, 'staging');
  assert.equal(plan.status, 'planned');
  assert.notEqual(plan.resources.acs.namespace, 'agent-saas-coding');
  assert.equal(plan.defaults.cronEnabled, false);
  assert.equal(plan.defaults.productionOAuthEnabled, false);
  assert.ok(JSON.stringify(plan).includes('UNASSIGNED'));
  assert.equal(plan.requiredEvidence.length, 7);
});
