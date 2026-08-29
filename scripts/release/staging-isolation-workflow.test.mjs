import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../../.github/workflows/deploy-staging.yml', import.meta.url);
const resourcePath = new URL('../../infra/staging/resource-plan.json', import.meta.url);

test('Staging RC collects, publishes, and reads back fresh isolation evidence', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /collect-isolation-host\.mjs/u);
  assert.match(workflow, /collect-isolation-evidence\.mjs/u);
  assert.match(workflow, /publish-isolation-evidence\.mjs/u);
  assert.match(workflow, /isolation-summary-expected\.json/u);
  assert.match(workflow, /diff <\(jq -S \. .*isolation-evidence-input\.json/u);
  assert.doesNotMatch(workflow, /RELEASE_EVIDENCE_WRITE_TOKEN/u);
  assert.ok(
    workflow.indexOf('Verify live reverse-isolation evidence') <
      workflow.indexOf('Run real browser and ACS E2E'),
  );
});

test('Staging resource plan binds every production isolation target', async () => {
  const plan = JSON.parse(await readFile(resourcePath, 'utf8'));

  assert.deepEqual(plan.resources.isolationTargets, {
    productionDatabase: 'agent_runtime',
    productionRuntimeTable: 'runtime_runs',
    productionAcsHost: '172.16.177.80',
    productionAcsPort: 3400,
    productionNamespace: 'agent-saas-coding',
    productionWebBucket: 'agent-saas-web',
    productionWebSentinelKey: 'index.html',
    productionWebSentinelUrl: 'https://agent-saas-web.oss-cn-shenzhen.aliyuncs.com/index.html',
    productionMountPaths: ['/mnt/agent-saas', '/mnt/agent-saas-app'],
  });
});
