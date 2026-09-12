import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { classifyChangedPaths } from './classify-components.mjs';

test('ACR recovery tests are explicitly non-runtime release paths', () => {
  const result = classifyChangedPaths([
    'scripts/test_acr_image_supervisor.py',
    'scripts/test_acr_webhook_redelivery.py',
  ]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.components, []);
});

test('ACR recovery state machine and exact webhook replay regressions', () => {
  const result = spawnSync(
    'python3',
    [
      '-m',
      'unittest',
      'scripts/test_acr_image_supervisor.py',
      'scripts/test_acr_webhook_redelivery.py',
    ],
    {
      cwd: new URL('../..', import.meta.url),
      encoding: 'utf8',
      timeout: 20000,
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('image recovery is single-flight per SHA and outside the Staging mutation slot', () => {
  const source = readFileSync(
    new URL('../../.github/workflows/deploy-staging.yml', import.meta.url),
    'utf8',
  );
  const prepare = source.split('  prepare-acs:')[1].split('  build-deploy-verify:')[0];
  const deploy = source.split('  build-deploy-verify:')[1];
  assert.match(prepare, /group: acr-image-\$\{\{ needs.prepare-evidence.outputs.source_sha \}\}/u);
  assert.doesNotMatch(
    prepare,
    /group: staging-runtime|environment: production|deploy-staging-release.sh/u,
  );
  assert.match(prepare, /ACS_WEBHOOK_REDELIVERY_TOKEN/u);
  assert.match(prepare, /package-manager-cache: false/u);
  assert.match(prepare, /if: always\(\)/u);
  assert.match(deploy, /needs: \[prepare-evidence, prepare-acs\]/u);
  assert.doesNotMatch(deploy, /WEBHOOK_REDELIVERY_TOKEN/u);
  assert.match(deploy, /ACR_SINGLE_PROBE=true/u);
  assert.match(deploy, /timeout --kill-after=5s 120s/u);
  assert.match(deploy, /diff <\(jq -S \. "\$RUNNER_TEMP\/acs-image-prepared.json"\)/u);
  assert.match(deploy, /name: \$\{\{ needs.prepare-acs.outputs.artifact_name \}\}/u);
  assert.match(prepare, /artifact_name: \$\{\{ steps.image.outputs.artifact_name \}\}/u);
});
