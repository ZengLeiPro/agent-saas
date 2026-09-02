import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflowPath = path.join(repo, '.github/workflows/mobile-rc-regression.yml');
const source = await readFile(workflowPath, 'utf8');
const workflow = YAML.parse(source);

test('M70-01 workflow YAML parses and exposes only call/dispatch real-RC entry points', () => {
  assert.equal(workflow.name, 'Mobile M70-01 RC Regression');
  assert.ok(workflow.on.workflow_call); assert.ok(workflow.on.workflow_dispatch);
  assert.equal(workflow.on.pull_request, undefined);
  assert.equal(workflow.jobs.real_matrix.if, 'inputs.configured');
  assert.match(workflow.jobs.contract.steps.map((step) => step.run ?? '').join('\n'), /test:m70-01/);
});

test('M70-01 workflow does not infer devices, builds, or install providers', () => {
  assert.doesNotMatch(source, /brew install|apt-get|npm install -g|maestro cloud|devicefarm|browserstack|saucelabs/i);
  assert.match(source, /test -x "\$PROVIDER_EXECUTABLE"/);
  assert.match(source, /matrix_json/);
});

test('M70-01 evidence upload is finite and excludes request files and secrets', () => {
  const upload = workflow.jobs.real_matrix.steps.find((step) => step.name?.startsWith('Upload only bounded'));
  const paths = upload.with.path;
  assert.match(paths, /result\.json/); assert.match(paths, /provider-receipt\.json/); assert.match(paths, /evidence\/\*/);
  assert.doesNotMatch(paths, /provider-request|\.env|secret|token/i);
  assert.match(source, /retention-days: 14/);
});

test('M70-01 shell commands consume matrix values through env rather than expression interpolation', () => {
  const runScripts = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []).map((step) => step.run ?? '').join('\n');
  assert.doesNotMatch(runScripts, /\$\{\{\s*matrix\.(?:providerExecutable|caseId|artifactDigest|m60ReceiptId|buildId)\s*\}\}/);
  assert.doesNotMatch(runScripts, /set \+x|curl .*\$MOBILE_|echo .*MOBILE_.*(?:TOKEN|KEY)/i);
});
