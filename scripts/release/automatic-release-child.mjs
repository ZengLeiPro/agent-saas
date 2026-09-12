import assert from 'node:assert/strict';
import { appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readEvidenceJson } from './evidence-file.mjs';
import { AutomaticGitHub } from './automatic-release-github.mjs';
import {
  assertRequest,
  assertRun,
  assertStep,
  ID_PATTERN,
  requireAutomatic,
} from './automatic-release-contract.mjs';

/** Read-only authentication before a child receives credentials, and again before mutation. */
export async function authenticateChild(
  client,
  { inputs, runId, runAttempt, workflow, live = true },
) {
  const id = inputs?.automation_id ?? '';
  const key = inputs?.automation_key ?? '';
  requireAutomatic(
    ID_PATTERN.test(id) && key,
    'invalid_delegation',
    '自动发布子任务缺少可验证的委派记录。',
  );
  const stepRecord = await client.api(`deployments/${id}`);
  const requestId = stepRecord.payload?.requestId;
  assert(ID_PATTERN.test(String(requestId)));
  const requestRecord = await client.api(`deployments/${requestId}`);
  assert.equal(String(requestRecord.id), String(requestId));
  const parentId = requestRecord.payload?.parentRunId;
  assert(ID_PATTERN.test(String(parentId)));
  const parentRun = await client.api(`actions/runs/${parentId}`);
  const request = assertRequest(requestRecord, parentRun, client.repository);
  const step = assertStep(stepRecord, request);
  assert.equal(String(stepRecord.id), id);
  assert.equal(step.key, key);
  assert.equal(step.workflow, workflow);
  assert.equal(String(step.requestId), String(requestRecord.id));
  const actual = { ...inputs };
  delete actual.automation_id;
  delete actual.automation_key;
  // Workflow UI adds default empty advanced fields; those are not additional authority.
  for (const field of ['expected_plan_digest', 'confirm_recovery_only']) {
    if (['', 'false', false, undefined].includes(actual[field])) delete actual[field];
  }
  assert.deepEqual(actual, step.inputs, 'Child inputs differ from the immutable reservation');
  const run = await client.api(`actions/runs/${runId}`);
  assertRun(run, client.repository, workflow, step.engineSha);
  assert.equal(String(run.id), String(runId));
  assert.equal(String(run.run_attempt), String(runAttempt));
  assert.equal(
    Number(runAttempt),
    1,
    'Do not rerun mutating child jobs; resume the parent request',
  );
  assert.equal(run.display_title, key);
  assert(Date.parse(stepRecord.created_at) <= Date.parse(run.created_at) + 1000);
  assert(Date.parse(requestRecord.created_at) <= Date.parse(stepRecord.created_at) + 1000);
  if (live) {
    requireAutomatic(
      parentRun.status === 'in_progress' &&
        String(parentRun.run_attempt) === String(step.parentRunAttempt),
      'parent_not_live',
      '父发布请求已停止或换代，子任务不得开始新的变更。',
    );
    assert.equal(run.status, 'in_progress');
  }
  return { requestRecord, stepRecord, parentRun, run };
}

export async function childMain(env = process.env) {
  const event = await readEvidenceJson(env.GITHUB_EVENT_PATH, 1048576);
  const inputs = event.inputs ?? {};
  const workflow = process.argv[2];
  assert(['promote-release.yml', 'deploy-staging.yml'].includes(workflow));
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  const delegated = !!(inputs.automation_id || inputs.automation_key);
  let context;
  if (delegated) {
    context = await authenticateChild(new AutomaticGitHub(env.GITHUB_REPOSITORY), {
      inputs,
      workflow,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
    });
  }
  const source = context?.stepRecord.payload.sourceSha ?? env.GITHUB_SHA;
  assert(/^[a-f0-9]{40}$/u.test(source));
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(context ?? null) + '\n');
  if (env.GITHUB_OUTPUT)
    await appendFile(env.GITHUB_OUTPUT, `source_sha=${source}\nautomatic=${delegated}\n`);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await childMain();
  } catch (error) {
    console.error(`Automatic child rejected: ${error.code ?? 'invalid_binding'}`);
    process.exitCode = 1;
  }
}
