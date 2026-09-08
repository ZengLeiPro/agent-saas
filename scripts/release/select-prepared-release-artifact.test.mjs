import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPreparedReleaseArtifact } from './select-prepared-release-artifact.mjs';
const sha = 'a'.repeat(40);
const artifact = (attempt) => ({
  name: `release-packages-${sha}-123-${attempt}`,
  expired: false,
  workflow_run: { id: 123, head_sha: sha },
});
const job = (attempt) => ({
  name: '预检 / 真实发布包',
  run_id: 123,
  run_attempt: attempt,
  status: 'completed',
  conclusion: 'success',
  steps: [{ name: '保存可信 main 发布包', conclusion: 'success' }],
});
const select = (overrides = {}) =>
  selectPreparedReleaseArtifact({
    artifacts: [artifact(1)],
    sha,
    runId: 123,
    runAttempt: 2,
    jobsForAttempt: async (attempt) => [job(attempt)],
    ...overrides,
  });
test('a failed-jobs rerun reuses only its earlier successful package attempt', async () => {
  assert.deepEqual(await select(), { name: artifact(1).name, runAttempt: 1 });
});
test('a full rerun prefers its new successful package', async () => {
  assert.equal((await select({ artifacts: [artifact(1), artifact(2)] })).runAttempt, 2);
});
test('expired and future artifacts never substitute for verified package bytes', async () => {
  await assert.rejects(
    select({ artifacts: [{ ...artifact(1), expired: true }, artifact(3)] }),
    /Re-run all/u,
  );
});
test('foreign source, duplicate name and missing publication step fail closed', async () => {
  await assert.rejects(
    select({
      artifacts: [{ ...artifact(1), workflow_run: { id: 123, head_sha: 'b'.repeat(40) } }],
    }),
    /another source/u,
  );
  await assert.rejects(select({ artifacts: [artifact(1), artifact(1)] }), /Ambiguous/u);
  await assert.rejects(
    select({ jobsForAttempt: async () => [{ ...job(1), steps: [] }] }),
    /publish/u,
  );
});
test('failed producer and a mismatched attempt are not trusted', async () => {
  await assert.rejects(
    select({ jobsForAttempt: async () => [{ ...job(1), conclusion: 'failure' }] }),
    /Re-run all/u,
  );
  await assert.rejects(select({ jobsForAttempt: async () => [job(2)] }), /producer job/u);
});
