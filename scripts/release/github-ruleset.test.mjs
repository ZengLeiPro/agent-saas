import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { inspectMainRuleset, inspectRcTagRuleset } from './github-ruleset.mjs';

const target = JSON.parse(
  readFileSync(new URL('../../config/github-main-ruleset.json', import.meta.url)),
);
const tagTarget = JSON.parse(
  readFileSync(new URL('../../config/github-rc-tag-ruleset.json', import.meta.url)),
);

test('accepts the CI-gated single-maintainer main ruleset', () => {
  assert.deepEqual(inspectMainRuleset([target], target), { ok: true, reasons: [] });
});

test('accepts only update/deletion-protected RC tags without bypass actors', () => {
  assert.deepEqual(inspectRcTagRuleset([tagTarget], tagTarget), { ok: true, reasons: [] });
  const broken = structuredClone(tagTarget);
  broken.rules = broken.rules.filter((rule) => rule.type !== 'update');
  assert.match(inspectRcTagRuleset([broken], tagTarget).reasons.join('\n'), /update/u);
});

test('rejects human approval requirements, a missing ACS gate, unresolved conversations, or stale checks', () => {
  const broken = structuredClone(target);
  broken.rules.find((rule) => rule.type === 'pull_request').parameters.require_code_owner_review =
    true;
  broken.rules.find((rule) => rule.type === 'pull_request').parameters.require_last_push_approval =
    true;
  broken.rules.find(
    (rule) => rule.type === 'pull_request',
  ).parameters.required_approving_review_count = 1;
  broken.rules.find(
    (rule) => rule.type === 'pull_request',
  ).parameters.required_review_thread_resolution = false;
  const checks = broken.rules.find((rule) => rule.type === 'required_status_checks').parameters;
  checks.required_status_checks = [{ context: 'Build & Check' }];
  checks.strict_required_status_checks_policy = false;
  const result = inspectMainRuleset([broken], target);
  assert.equal(result.ok, false);
  assert.match(result.reasons.join('\n'), /CODEOWNER/);
  assert.match(result.reasons.join('\n'), /last-push approval/);
  assert.match(result.reasons.join('\n'), /approving review count/);
  assert.match(result.reasons.join('\n'), /conversation resolution/);
  assert.match(result.reasons.join('\n'), /ACS Impact Gate/);
  assert.match(result.reasons.join('\n'), /strict status checks/);
});
