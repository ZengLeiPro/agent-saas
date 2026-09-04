import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAcrBuildRevision } from './verify-acr-build-revision.mjs';

const SHA = '1234567890abcdef1234567890abcdef12345678';

function logs(stage, message) {
  return {
    Code: 'success',
    IsSuccess: true,
    BuildRecordLogs: [{ BuildStage: stage, Message: message }],
  };
}

test('accepts the exact full revision only from the selected build record GIT_CLONE stage', () => {
  assert.equal(verifyAcrBuildRevision(logs('GIT_CLONE', `checking out revision ${SHA}`), SHA), SHA);
});

test('rejects a six-character tag suffix as source revision evidence', () => {
  assert.throws(
    () =>
      verifyAcrBuildRevision(logs('GIT_CLONE', `checking out revision ${SHA.slice(0, 6)}`), SHA),
    /not bound to full source commit/u,
  );
});

test('rejects the full revision outside GIT_CLONE and rejects a different clone revision', () => {
  assert.throws(
    () => verifyAcrBuildRevision(logs('BUILD', `label=${SHA}`), SHA),
    /not bound to full source commit/u,
  );
  assert.throws(
    () => verifyAcrBuildRevision(logs('GIT_CLONE', `checking out ${'a'.repeat(40)}`), SHA),
    /not bound to full source commit/u,
  );
});

test('rejects malformed or unsuccessful ACR log responses', () => {
  assert.throws(
    () => verifyAcrBuildRevision({ Code: 'error', IsSuccess: false }, SHA),
    /Unable to read/u,
  );
  assert.throws(() => verifyAcrBuildRevision(logs('GIT_CLONE', SHA), '123456'), /invalid/u);
});
