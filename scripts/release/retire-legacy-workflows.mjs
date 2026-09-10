#!/usr/bin/env node
// Retire registered identities, not history: no run/artifact/branch deletion and no deployment.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkWorkflowInventory, repositoryRoot } from './workflow-inventory.mjs';

function githubApi(method, resource) {
  const output = execFileSync('gh', ['api', '--method', method, resource], { encoding: 'utf8' });
  return output.trim() ? JSON.parse(output) : null;
}

export function planRetirement(inventory, registered) {
  // Validate the entire snapshot before the first mutation. Never retire an unknown identity.
  for (const kept of inventory.workflows) {
    const matches = registered.filter((item) => item.path === kept.path);
    assert.equal(matches.length, 1, `Missing or duplicate retained workflow: ${kept.path}`);
    assert.equal(matches[0].name, kept.name, `Retained workflow name drift: ${kept.path}`);
    assert.equal(matches[0].state, 'active', `Retained workflow is not active: ${kept.path}`);
  }
  return inventory.retiredWorkflows.map((retired) => {
    const matches = registered.filter(
      (item) => item.id === retired.id || item.path === retired.path,
    );
    if (!matches.length) return { ...retired, action: 'absent' };
    assert.equal(matches.length, 1, `Ambiguous retired workflow: ${retired.path}`);
    const actual = matches[0];
    for (const key of ['id', 'path', 'name']) {
      assert.equal(actual[key], retired[key], `Retired workflow ${key} drift: ${retired.path}`);
    }
    assert(
      ['active', 'deleted', 'disabled_manually', 'disabled_inactivity', 'disabled_fork'].includes(
        actual.state,
      ),
      'Unknown workflow state',
    );
    return { ...retired, action: actual.state === 'active' ? 'disable' : 'already-retired' };
  });
}

export function retireLegacyWorkflows({
  apply = false,
  env = process.env,
  root = repositoryRoot,
  api = githubApi,
} = {}) {
  const inventory = checkWorkflowInventory(root);
  // These numeric IDs belong to this repository only; forks must not apply this manifest.
  assert.equal(
    env.GITHUB_REPOSITORY,
    'ZengLeiPro/agent-saas',
    'Retirement inventory belongs to another repository',
  );
  const base = `repos/${env.GITHUB_REPOSITORY}`;
  if (apply) {
    assert.equal(env.GITHUB_EVENT_NAME, 'push', 'Only a green main push CI may apply retirement');
    assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Retirement requires main');
    assert(/^[a-f0-9]{40}$/u.test(env.GITHUB_SHA), 'Retirement requires an exact source SHA');
  }
  const current = () => api('GET', `${base}/git/ref/heads/main`).object.sha === env.GITHUB_SHA;
  if (apply && !current())
    return {
      mode: 'deferred',
      reason: 'main advanced; the newer CI owns retirement',
      workflows: [],
    };
  const registered = [];
  for (let page = 1; ; page += 1) {
    assert(page <= 100, 'Workflow pagination did not terminate');
    const result = api('GET', `${base}/actions/workflows?per_page=100&page=${page}`);
    assert(Array.isArray(result.workflows), 'Invalid workflow registry response');
    registered.push(...result.workflows);
    if (result.workflows.length < 100) break;
  }
  const plan = planRetirement(inventory, registered);
  if (!apply) return { mode: 'audit', workflows: plan };
  for (const item of plan) {
    if (item.action !== 'disable') continue;
    // A queued old main run must not disable a workflow reintroduced by a newer reviewed commit.
    if (!current())
      return { mode: 'deferred', reason: 'main advanced during retirement', workflows: plan };
    api('PUT', `${base}/actions/workflows/${item.id}/disable`);
    const actual = api('GET', `${base}/actions/workflows/${item.id}`);
    assert.equal(actual.path, item.path, 'Workflow path changed during retirement');
    assert.equal(actual.state, 'disabled_manually', `Retirement readback failed: ${item.path}`);
    item.action = 'disabled';
  }
  return { mode: 'applied', workflows: plan };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    assert(
      args.length === 0 || (args.length === 1 && args[0] === '--apply'),
      'Usage: retire-legacy-workflows.mjs [--apply]',
    );
    const report = retireLegacyWorkflows({ apply: args.includes('--apply') });
    console.log(JSON.stringify(report, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Legacy workflow retirement\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n\nHistorical runs and artifacts are retained; in-flight runs are not cancelled.\n`,
      );
    }
  } catch (error) {
    console.error(`Workflow retirement failed: ${error.message}`);
    process.exitCode = 1;
  }
}
