import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyPath } from './classify-components.mjs';

for (const path of [
  'scripts/ci-acs-plan.mjs',
  'scripts/release/unified-ci-evidence.mjs',
  'scripts/release/unified-ci-workflow.test.mjs',
]) {
  test(`unified CI helper is an explicitly mapped non-runtime input: ${path}`, () => {
    assert.deepEqual(classifyPath(path), { components: [], blockingReason: null });
  });
}
