import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { inspectMainRuleset } from './github-ruleset.mjs';

const target = JSON.parse(
  readFileSync(new URL('../../config/github-main-ruleset.json', import.meta.url)),
);

test('accepts the exact protected-main ruleset', () => {
  assert.deepEqual(inspectMainRuleset([target], target), { ok: true, reasons: [] });
});

test('rejects a ruleset without ACS gate, conversation resolution, or strict freshness', () => {
  const broken = structuredClone(target);
  broken.rules.find(
    (rule) => rule.type === 'pull_request',
  ).parameters.required_review_thread_resolution = false;
  const checks = broken.rules.find((rule) => rule.type === 'required_status_checks').parameters;
  checks.required_status_checks = [{ context: 'Build & Check' }];
  checks.strict_required_status_checks_policy = false;
  const result = inspectMainRuleset([broken], target);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /conversation resolution/);
  assert.match(result.reasons.join('\n'), /ACS Impact Gate/);
  assert.match(result.reasons.join('\n'), /strict status checks/);
});
