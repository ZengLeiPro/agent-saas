import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const root = path.resolve(import.meta.dirname, '../../..');
const files = ['.github/workflows/mobile-rollout-gate.yml', '.github/workflows/mobile-rollout-emergency.yml'];
const sources = Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(path.join(root, file), 'utf8')])));
const workflows = Object.fromEntries(Object.entries(sources).map(([file, source]) => [file, YAML.parse(source)]));

test('M70-03 YAML parses with only workflow_call/dispatch production entry points', () => {
  for (const [file, workflow] of Object.entries(workflows)) {
    assert.ok(workflow.on.workflow_call, file); assert.ok(workflow.on.workflow_dispatch, file);
    assert.equal(workflow.on.push, undefined); assert.equal(workflow.on.pull_request, undefined);
  }
});

test('rollout sequence is evidence -> protected approval -> injected adapter -> observe -> evaluate', () => {
  const jobs = workflows['.github/workflows/mobile-rollout-gate.yml'].jobs;
  assert.equal(jobs.validate_evidence.needs, 'contract'); assert.equal(jobs.protected_approval.needs, 'validate_evidence'); assert.equal(jobs.provider_rollout.needs, 'protected_approval'); assert.equal(jobs.observe.needs, 'provider_rollout');
  assert.deepEqual(jobs.evaluate.needs, ['validate_evidence', 'protected_approval', 'provider_rollout', 'observe']);
  assert.match(jobs.protected_approval.environment, /mobile-rollout-gate-/);
});

test('workflow keeps submit/build separate and never guesses store/provider', () => {
  const source = sources['.github/workflows/mobile-rollout-gate.yml'];
  assert.doesNotMatch(source, /eas build|eas submit|mobile-submit\.yml|curl\s/u);
  assert.match(source, /test -x "\$PROVIDER_ADAPTER"/u); assert.match(source, /provider_adapter_executable/u);
  assert.match(source, /adapter unconfigured|Fail closed if adapter is absent/iu);
});

test('forks receive no production secret jobs and permissions/logs are bounded', () => {
  const all = Object.values(sources).join('\n');
  assert.match(all, /github\.repository == 'ZengLeiPro\/agent-saas'/u);
  assert.doesNotMatch(all, /pull_request_target|contents:\s*write|id-token:\s*write/u);
  assert.match(all, /ulimit -f 128/u); assert.match(all, /65536/u);
  assert.doesNotMatch(all, /echo\s+.*secrets\.|set -x/u);
});

test('pause/rollback path consumes only a cryptographically authorized stopped receipt', () => {
  const emergency = sources['.github/workflows/mobile-rollout-emergency.yml'];
  assert.match(emergency, /authorize-emergency/u); assert.match(emergency, /signed stopped receipt only/iu);
  assert.match(emergency, /options: \[pause, rollback\]/u); assert.doesNotMatch(emergency, /resume|override/u);
});

test('machine schemas and canonical/test policies are parseable JSON', async () => {
  for (const file of ['mobile/rollout/schema/rollout-policy.schema.json', 'mobile/rollout/schema/gate-input.schema.json', 'mobile/rollout/schema/stage-receipt.schema.json', 'mobile/rollout/rollout-policy.json', 'mobile/rollout/fixtures/rollout-policy.test-fixture.json']) { const source = await readFile(path.join(root, file), 'utf8'); assert.doesNotThrow(() => JSON.parse(source), file); }
});
