import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { planAcsCi } from '../ci-acs-plan.mjs';
import { checkWorkflowInventory, repositoryRoot } from './workflow-inventory.mjs';

const read = (path) => readFileSync(join(repositoryRoot, path), 'utf8');
const ci = read('.github/workflows/ci.yml');
const production = read('.github/workflows/promote-release.yml');
function job(source, id) {
  const start = source.indexOf(`\n  ${id}:\n`);
  assert(start >= 0, `Missing job ${id}`);
  const tail = source.slice(start + 1);
  const next = tail.search(/\n  [\w-]+:\n/u);
  return next < 0 ? tail : tail.slice(0, next);
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-inventory-'));
  for (const dir of ['.github/workflows', 'config'])
    cpSync(join(repositoryRoot, dir), join(root, dir), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('only four reviewed entrypoints remain; temporary authoring workflows are retired too', () => {
  const inventory = checkWorkflowInventory();
  assert.deepEqual(
    inventory.workflows.map((item) => item.name),
    ['CI', '测试环境部署', '测试环境验收', '生产环境发布'],
  );
  assert.equal(inventory.retiredWorkflows.length, 6);
  assert(ci.includes('run: node scripts/release/workflow-inventory.mjs'));
});

test('inventory rejects reintroduced workflows, missing entries and renamed titles', (t) => {
  const root = fixture(t);
  const extra = join(root, '.github/workflows/prepare-unified-ci.yml');
  writeFileSync(extra, 'name: Prepare unified CI (branch-only)\non: push\n');
  assert.throws(() => checkWorkflowInventory(root), /reviewed inventory/u);
  rmSync(extra);
  const ciPath = join(root, '.github/workflows/ci.yml');
  writeFileSync(
    ciPath,
    read('.github/workflows/ci.yml').replace('name: CI\n', 'name: Another CI\n'),
  );
  assert.throws(() => checkWorkflowInventory(root), /display name/u);
  rmSync(ciPath);
  assert.throws(() => checkWorkflowInventory(root), /reviewed inventory/u);
});

test('all former ACS evidence paths still select a hard CI gate', () => {
  for (const path of [
    'server/unrelated-file.ts',
    'acs-orchestrator/src/remote/test_worker.py',
    'acs-orchestrator/src/sandboxRunner.ts',
    'acs-orchestrator/src/remoteAttemptProtocol.ts',
    'docs/engineering/acs-repair/new-evidence.md',
    'Dockerfile',
    '.github/workflows/ci.yml',
    'scripts/ci-acs-plan.mjs',
    'config/github-workflow-inventory.json',
  ])
    assert.equal(planAcsCi('pull_request', [path]).required, true, path);
  assert.equal(planAcsCi('pull_request', ['README.md']).required, false);
  assert.equal(planAcsCi('pull_request', ['web/src/App.tsx']).required, false);
});

test('ACS gate explicitly runs native processes and the real bundle; evidence never masks failure', () => {
  const acs = job(ci, 'acs-impact-gate');
  for (const command of [
    "timeout 120s python3 -B -m unittest discover -s acs-orchestrator/src/remote -p 'test_*.py' -v",
    'pnpm -F acs-orchestrator build',
    'pnpm -F acs-orchestrator test --reporter=default --reporter=json',
    'source-sha.txt',
    'native-source-sha256.txt',
    'orchestrator-tests.json',
    'bundle-sha256.txt',
    'sourceSha:',
    'prHeadSha:',
    'productionActions: false',
    'persist-credentials: false',
  ])
    assert(acs.includes(command), command);
  assert.match(acs, /set -euo pipefail/u);
  assert.match(acs, /always\(\).*acs_required == 'true'/u);
  assert.doesNotMatch(acs, /continue-on-error|secrets\.|environment:\s*production/u);
  assert.match(job(ci, 'build'), /acs_impact_gate=\$ACS_IMPACT_GATE_RESULT=true/u);
  const configPath = join(repositoryRoot, 'acs-orchestrator/package.json');
  const scripts = JSON.parse(readFileSync(configPath, 'utf8')).scripts;
  assert.match(scripts.test, /vitest run/u);
  // The full Vitest suite supersedes the former evidence workflow's two selected lists.
  for (const file of [
    'acsHangRegression',
    'ownershipReaderRegression',
    'ownershipPrimitives',
    'ownedWorkIntegration',
    'ownedBudgetRegression',
    'provisionBudgets',
    'remoteAttemptProtocol.security',
  ]) {
    assert(read(`acs-orchestrator/src/${file}.test.ts`).trim(), file);
  }
});

test('CI Web-only compatibility remains protected, confirmed, serialized and main-only', () => {
  assert.match(ci, /web_only_compatibility:[\s\S]*default: false/u);
  assert.match(ci, /github.event_name == 'workflow_dispatch' && 'production-runtime'/u);
  const plan = job(ci, 'deploy_plan');
  assert.match(
    plan,
    /github.ref == 'refs\/heads\/main' && github.event_name == 'workflow_dispatch'/u,
  );
  assert.match(plan, /inputs.web_only_compatibility != true/u);
  assert.match(plan, /block_server_compatibility/u);
  for (const id of ['deploy_plan', 'deploy-web-oss'])
    assert.match(job(ci, id), /environment: production/u);
});

test('production operations are selected before secrets, mutually exclusive, and retain recovery locks', () => {
  const dispatch = job(production, 'dispatch');
  const promote = job(production, 'promote');
  const recovery = job(production, 'web_recovery');
  assert.match(dispatch, /run: node scripts\/release\/production-operation.mjs/u);
  assert.doesNotMatch(dispatch, /secrets\.|environment:\s*production/u);
  assert.match(production, /default: promote/u);
  assert.match(production, /release_id:[\s\S]*?required: false/u);
  assert.match(production, /group: production-runtime\s+cancel-in-progress: false/u);
  for (const value of [promote, recovery]) {
    assert.match(value, /needs: dispatch/u);
    assert.match(value, /github.ref == 'refs\/heads\/main'/u);
    assert.match(value, /environment: production/u);
  }
  assert.match(promote, /needs.dispatch.outputs.operation == 'promote'/u);
  assert.match(
    recovery,
    /needs.dispatch.outputs.operation == 'web-recovery-audit' \|\| needs.dispatch.outputs.operation == 'web-recovery-repair'/u,
  );
  assert.match(recovery, /permissions:\s+contents: read/u);
  assert.doesNotMatch(recovery, /contents: write|deployments: write/u);
  assert.match(recovery, /RECOVERY_MODE: \$\{\{ needs.dispatch.outputs.recovery_mode \}\}/u);
  for (const text of [
    'test "$CONFIRM_RECOVERY_ONLY" = true',
    '^sha256:[a-f0-9]{64}$',
    'PRODUCTION_SSH_HOST_KEY_SHA256',
    'production-lock-lease.sh',
    'run-with-production-lock-guard.sh',
    'web-recovery-report.json',
    'if: always() && env.RECOVERY_LOCK_ACQUIRED',
  ])
    assert(recovery.includes(text), text);
  assert.doesNotMatch(promote, /python3 scripts\/release\/repair-web-recovery.py/u);
  assert.doesNotMatch(recovery, /deploy-production-release.sh|write-live-production-identity/u);
});

test('post-merge retirement depends on green CI and has no production or PR write authority', () => {
  const retirement = job(ci, 'retire_legacy_workflows');
  assert.match(retirement, /needs: build/u);
  assert.match(retirement, /github.event_name == 'push' && github.ref == 'refs\/heads\/main'/u);
  assert.match(retirement, /actions: write/u);
  assert.match(retirement, /contents: read/u);
  assert.match(retirement, /retire-legacy-workflows.mjs --apply/u);
  assert.doesNotMatch(retirement, /secrets\.|environment:|contents: write|pull-requests:/u);
});
