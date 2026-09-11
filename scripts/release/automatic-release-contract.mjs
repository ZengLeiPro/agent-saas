import assert from 'node:assert/strict';
import { canonicalJson, digestBuffer, SHA_PATTERN, DIGEST_PATTERN } from './artifact-lib.mjs';

export const REQUEST_ENVIRONMENT = 'production-request';
export const REQUEST_TASK = 'automatic-release-request';
export const STEP_TASK = 'automatic-release-step';
export const RC_PATTERN = /^rc-[0-9]{8}-[0-9]{2,}$/u;
export const ID_PATTERN = /^[1-9][0-9]*$/u;
export const STAGE_PATTERN =
  /^(recover|refresh|publish|recover-checkpoint-[1-9][0-9]*|verify-[1-9][0-9]*)$/u;
export const WORKFLOWS = ['promote-release.yml', 'deploy-staging.yml'];
export const hash = (value) => digestBuffer(Buffer.from(canonicalJson(value)));
export const seal = (body) => ({ ...body, digest: hash(body) });

export function requireAutomatic(condition, code, message) {
  if (condition) return;
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function unseal(value, kind) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  const { digest, ...body } = value;
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.kind, kind);
  assert(DIGEST_PATTERN.test(digest ?? '') && digest === hash(body), 'Request digest mismatch');
  return body;
}

export function assertRun(run, repository, workflow, sha) {
  assert(ID_PATTERN.test(String(run?.id)) && Number.isSafeInteger(Number(run.id)));
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.path, `.github/workflows/${workflow}`);
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.head_branch, 'main');
  assert(SHA_PATTERN.test(run.head_sha ?? ''));
  if (sha) assert.equal(run.head_sha, sha, 'Deployment engine changed after request was pinned');
}

export function assertRequest(record, run, repository) {
  const value = record?.payload;
  unseal(value, 'automatic-release-request');
  assertRun(run, repository, 'promote-release.yml', value.engineSha);
  assert.equal(record.environment, REQUEST_ENVIRONMENT);
  assert.equal(record.task, REQUEST_TASK);
  assert.equal(record.sha, value.engineSha);
  assert.equal(value.repository, repository);
  assert.equal(value.parentRunId, String(run.id));
  assert.equal(value.requestedAt, run.created_at);
  assert(Number.isFinite(Date.parse(value.requestedAt)));
  assert(
    Number.isFinite(Date.parse(value.target?.verifiedAt)) &&
      Date.parse(value.target.verifiedAt) <= Date.parse(value.requestedAt),
  );
  assert(SHA_PATTERN.test(value.target?.sourceSha ?? ''));
  assert(RC_PATTERN.test(value.target?.releaseId ?? ''));
  assert(DIGEST_PATTERN.test(value.target?.manifestDigest ?? ''));
  assert.equal(typeof value.reason, 'string');
  assert(value.reason.trim() && value.reason.length <= 2048);
  return value;
}

export function assertStep(record, request) {
  const value = record?.payload;
  unseal(value, 'automatic-release-step');
  assert.equal(record.environment, REQUEST_ENVIRONMENT);
  assert.equal(record.task, STEP_TASK);
  assert.equal(record.sha, request.engineSha);
  assert.equal(value.repository, request.repository);
  assert.equal(value.parentRunId, request.parentRunId);
  assert.equal(value.requestDigest, request.digest);
  assert(ID_PATTERN.test(String(value.requestId)));
  assert(Number.isSafeInteger(value.parentRunAttempt) && value.parentRunAttempt > 0);
  assert.equal(value.engineSha, request.engineSha);
  assert(STAGE_PATTERN.test(value.stage ?? ''));
  assert.equal(value.key, `auto:${request.parentRunId}:${value.stage}`);
  assert.equal(
    value.workflow,
    value.stage === 'refresh' ? 'deploy-staging.yml' : 'promote-release.yml',
  );
  assert(SHA_PATTERN.test(value.sourceSha ?? ''));
  if (value.stage === 'refresh') {
    assert.equal(value.sourceSha, request.target.sourceSha);
    assert.deepEqual(Object.keys(value.inputs).sort(), ['reason']);
  } else {
    assert(RC_PATTERN.test(value.inputs?.release_id ?? ''));
    const checkpoint = value.stage.includes('checkpoint') || value.stage.startsWith('verify-');
    assert.equal(value.inputs.operation, checkpoint ? 'checkpoint-repair' : 'promote');
    assert.equal(value.inputs.recovery_mode, 'normal');
    assert.deepEqual(Object.keys(value.inputs).sort(), [
      'operation',
      'reason',
      'recovery_mode',
      'release_id',
    ]);
    if (value.stage === 'publish' || value.stage.startsWith('verify-'))
      assert.equal(
        value.sourceSha,
        request.target.sourceSha,
        'Recovery must not replace the requested target',
      );
  }
  assert.equal(typeof value.inputs.reason, 'string');
  assert(value.inputs.reason.trim() && value.inputs.reason.length <= 4096);
  return value;
}

export function normalizedComponents(components) {
  const result = {};
  for (const name of ['web', 'api', 'runtimeWorker', 'acs']) {
    const component = components?.[name];
    assert(SHA_PATTERN.test(component?.sourceSha ?? component?.gitSha ?? ''));
    result[name] = { sourceSha: component.sourceSha ?? component.gitSha };
    for (const key of name === 'acs'
      ? ['orchestratorArtifactDigest', 'sandboxImageDigest']
      : ['artifactDigest']) {
      assert(DIGEST_PATTERN.test(component[key] ?? ''));
      result[name][key] = component[key];
    }
  }
  return result;
}
