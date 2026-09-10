import assert from 'node:assert/strict';
import test from 'node:test';
import { checkWorkflowInventory } from './workflow-inventory.mjs';
import { planRetirement, retireLegacyWorkflows } from './retire-legacy-workflows.mjs';

const inventory = checkWorkflowInventory();
const sha = 'a'.repeat(40);
const env = {
  GITHUB_REPOSITORY: 'ZengLeiPro/agent-saas',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
  GITHUB_SHA: sha,
};
const snapshot = () => [
  ...inventory.workflows.map((item, i) => ({ ...item, id: i + 1, state: 'active' })),
  ...inventory.retiredWorkflows.map((item) => ({ ...item, state: 'active' })),
];

function fixture({ source = snapshot(), currentSha = sha } = {}) {
  const calls = [];
  const api = (method, resource) => {
    calls.push({ method, resource });
    if (resource.endsWith('/git/ref/heads/main')) return { object: { sha: currentSha } };
    if (resource.includes('/actions/workflows?')) return { workflows: source };
    const match = /\/actions\/workflows\/(\d+)(\/disable)?$/u.exec(resource);
    assert(match, `Unexpected API call: ${method} ${resource}`);
    const workflow = source.find((item) => item.id === Number(match[1]));
    assert(workflow);
    if (method === 'PUT') {
      assert.equal(match[2], '/disable');
      workflow.state = 'disabled_manually';
      return null;
    }
    assert.equal(method, 'GET');
    return workflow;
  };
  return { api, calls, source };
}

test('audit is read-only; apply disables only the six exact known identities and is idempotent', () => {
  const f = fixture();
  assert.equal(retireLegacyWorkflows({ env, api: f.api }).mode, 'audit');
  assert(f.calls.every((call) => call.method === 'GET'));
  assert.equal(retireLegacyWorkflows({ apply: true, env, api: f.api }).mode, 'applied');
  const writes = f.calls.filter((call) => call.method === 'PUT');
  assert.equal(writes.length, 6);
  for (const call of writes) assert.match(call.resource, /\/actions\/workflows\/\d+\/disable$/u);
  assert.equal(retireLegacyWorkflows({ apply: true, env, api: f.api }).mode, 'applied');
  assert.equal(f.calls.filter((call) => call.method === 'PUT').length, 6);
  for (const kept of f.source.slice(0, 4)) assert.equal(kept.state, 'active');
});

test('a stale main CI defers without mutation and the latest CI owns retirement', () => {
  const f = fixture({ currentSha: 'b'.repeat(40) });
  assert.equal(retireLegacyWorkflows({ apply: true, env, api: f.api }).mode, 'deferred');
  assert(f.calls.every((call) => call.method === 'GET'));
});

test('PR, manual, non-main and fork invocations cannot apply retirement', () => {
  for (const overrides of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_REPOSITORY: 'fork/agent-saas' },
    { GITHUB_SHA: 'main' },
  ]) {
    const f = fixture();
    assert.throws(() =>
      retireLegacyWorkflows({ apply: true, env: { ...env, ...overrides }, api: f.api }),
    );
    assert(f.calls.every((call) => call.method === 'GET'));
  }
});

test('all retired IDs, names and paths are checked before any write; kept workflows cannot be disabled', () => {
  for (const mutate of [
    (items) => {
      items.at(-1).id += 1;
    },
    (items) => {
      items.at(-1).name = 'Reassigned identity';
    },
    (items) => {
      items.at(-1).path = '.github/workflows/ci.yml';
    },
    (items) => {
      items[0].state = 'disabled_manually';
    },
    (items) => {
      items.push({ ...items.at(-1) });
    },
  ]) {
    const source = snapshot();
    mutate(source);
    const f = fixture({ source });
    assert.throws(() => retireLegacyWorkflows({ apply: true, env, api: f.api }));
    assert(f.calls.every((call) => call.method === 'GET'));
  }
});

test('absent/deleted workflow records are already retired; unrelated historical identities are untouched', () => {
  const source = snapshot();
  source.at(-1).state = 'deleted';
  const absent = source.pop();
  assert.equal(
    planRetirement(inventory, source).find((item) => item.id === absent.id).action,
    'absent',
  );
  source.push(absent, {
    id: 999,
    path: '.github/workflows/unrelated-history.yml',
    name: 'History',
    state: 'active',
  });
  const plan = planRetirement(inventory, source);
  assert.equal(plan.find((item) => item.id === absent.id).action, 'already-retired');
  assert(!plan.some((item) => item.id === 999));
});

test('retirement rejects failed disable readback', () => {
  const f = fixture();
  const api = (method, resource) => (method === 'PUT' ? null : f.api(method, resource));
  assert.throws(() => retireLegacyWorkflows({ apply: true, env, api }), /readback failed/u);
});
