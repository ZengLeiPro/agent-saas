import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUnifiedCiEvidence } from './unified-ci-evidence.mjs';

function fixture() {
  const sha = 'a'.repeat(40);
  const repository = 'owner/agent-saas';
  const workflow = { id: 42, path: '.github/workflows/ci.yml', name: 'CI' };
  const run = {
    id: 100, run_attempt: 2, workflow_id: 42, path: workflow.path,
    repository: { full_name: repository }, head_repository: { full_name: repository },
    event: 'push', head_branch: 'main', head_sha: sha, status: 'completed', conclusion: 'success',
  };
  const jobs = ['Build & Check', 'ACS Impact Gate'].map((name, index) => ({
    id: index + 1, name, run_id: run.id, head_sha: sha, run_attempt: 2,
    status: 'completed', conclusion: 'success',
  }));
  return { workflow, initialRun: structuredClone(run), finalRun: run,
    pages: [{ total_count: jobs.length, jobs }], sha, repository };
}

test('one trusted run supplies both legacy evidence identities without a schema change', () => {
  const input = fixture();
  const result = buildUnifiedCiEvidence(input);
  assert.deepEqual(result, {
    appCi: { workflow: 'Build & Check', status: 'success', headSha: input.sha, runId: 100 },
    acsImpact: { workflow: 'ACS Impact Gate', status: 'success', headSha: input.sha, runId: 100 },
  });
  input.workflow.name = '任意显示名';
  assert.deepEqual(buildUnifiedCiEvidence(input), result);
});

for (const field of ['initialRun', 'finalRun']) {
  for (const [property, value] of Object.entries({
    workflow_id: 99, path: '.github/workflows/acs-sandbox.yml', event: 'workflow_dispatch',
    head_branch: 'feature', head_sha: 'b'.repeat(40), status: 'in_progress', conclusion: 'failure',
    repository: { full_name: 'attacker/fork' }, head_repository: { full_name: 'attacker/fork' },
  })) {
    test(`rejects ${field}.${property} mismatch`, () => {
      const input = fixture(); input[field][property] = value;
      assert.throws(() => buildUnifiedCiEvidence(input));
    });
  }
}

test('rejects a rerun racing evidence collection', () => {
  const input = fixture(); input.finalRun.run_attempt = 3;
  assert.throws(() => buildUnifiedCiEvidence(input), /attempt changed/u);
});

test('allows a successful carried job from an earlier attempt returned by filter=latest', () => {
  const input = fixture(); input.pages[0].jobs[1].run_attempt = 1;
  assert.equal(buildUnifiedCiEvidence(input).acsImpact.runId, 100);
});

for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', 'timed_out', null]) {
  for (const index of [0, 1]) {
    test(`rejects gate ${index} with conclusion ${conclusion}`, () => {
      const input = fixture(); input.pages[0].jobs[index].conclusion = conclusion;
      assert.throws(() => buildUnifiedCiEvidence(input), /not successful/u);
    });
  }
}

for (const mutation of [
  (input) => { input.pages[0].jobs.pop(); input.pages[0].total_count = 1; },
  (input) => { input.pages[0].jobs[1].name = 'Build & Check'; },
  (input) => { input.pages[0].jobs[1].run_id = 101; },
  (input) => { input.pages[0].jobs[1].head_sha = 'b'.repeat(40); },
  (input) => { input.pages[0].jobs[1].run_attempt = 3; },
  (input) => { input.pages[0].jobs[1].run_attempt = 0; },
  (input) => { input.pages[0].jobs[1].status = 'queued'; },
  (input) => { input.pages[0].jobs[1].id = 1; },
  (input) => { input.pages[0].total_count = 3; },
  (input) => { input.pages = []; },
  (input) => { input.workflow.id = 99; },
  (input) => { input.workflow.path = '.github/workflows/other.yml'; },
]) {
  test(`rejects malformed/incomplete job evidence ${mutation.toString()}`, () => {
    const input = fixture(); mutation(input);
    assert.throws(() => buildUnifiedCiEvidence(input));
  });
}

test('reads gates beyond page one and refuses pagination drift', () => {
  const input = fixture();
  const otherJobs = Array.from({ length: 100 }, (_, index) => ({ id: index + 10, name: `test-${index}` }));
  input.pages = [
    { total_count: 102, jobs: otherJobs },
    { total_count: 102, jobs: input.pages[0].jobs },
  ];
  assert.equal(buildUnifiedCiEvidence(input).acsImpact.status, 'success');
  input.pages[1].total_count = 101;
  assert.throws(() => buildUnifiedCiEvidence(input), /pagination/u);
});
