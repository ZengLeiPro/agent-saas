import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyAcrBuildRevision } from './verify-acr-build-revision.mjs';

const SHA = '1234567890abcdef1234567890abcdef12345678';

// 真实 ACR ListRepoBuildRecordLog 返回：条目只有 LineNumber/Message，无阶段字段；
// fetch 阶段的 commit info 行只带 7 位缩写 SHA。
function logs(...messages) {
  return {
    Code: 'success',
    IsSuccess: true,
    BuildRecordLogs: messages.map((message, index) => ({ LineNumber: index + 1, Message: message })),
  };
}

const commitInfo = (sha, branch = 'main') =>
  `commit info:\t* ${branch} ${sha} [origin/${branch}] chore: subject (#1)`;

test('accepts a fetch-stage commit info whose abbreviated SHA prefixes the expected revision', () => {
  const value = logs(
    '==========================================',
    '[fetch stage begin.]',
    'clone from remote repository: https://github.com/example/repo.git, branch: main',
    "Cloning into '/workspace'...",
    commitInfo(SHA.slice(0, 7)),
    '[fetch successfully, takes 9s.]',
  );
  assert.equal(verifyAcrBuildRevision(value, SHA), SHA);
  assert.equal(verifyAcrBuildRevision(value, SHA, { branch: 'main' }), SHA);
  assert.equal(verifyAcrBuildRevision(logs(commitInfo(SHA)), SHA), SHA);
});

test('rejects a commit info that does not prefix the expected revision', () => {
  assert.throws(() => verifyAcrBuildRevision(logs(commitInfo('abcdef0')), SHA), /cloned abcdef0/u);
  assert.throws(() => verifyAcrBuildRevision(logs(commitInfo('a'.repeat(40))), SHA), /refusing/u);
});

test('rejects abbreviations shorter than seven characters even when they match', () => {
  assert.throws(
    () => verifyAcrBuildRevision(logs(commitInfo(SHA.slice(0, 6))), SHA),
    /no fetch-stage commit info/u,
  );
});

test('rejects logs without any commit info line and revisions found elsewhere', () => {
  assert.throws(() => verifyAcrBuildRevision(logs(`label=${SHA}`), SHA), /no fetch-stage commit info/u);
  assert.throws(() => verifyAcrBuildRevision(logs(), SHA), /no fetch-stage commit info/u);
});

test('rejects a different branch when one is required and any conflicting commit info', () => {
  assert.throws(
    () => verifyAcrBuildRevision(logs(commitInfo(SHA.slice(0, 7), 'feature')), SHA, { branch: 'main' }),
    /cloned branch feature/u,
  );
  assert.throws(
    () => verifyAcrBuildRevision(logs(commitInfo(SHA.slice(0, 7)), commitInfo('abcdef0')), SHA),
    /cloned abcdef0/u,
  );
});

test('rejects malformed or unsuccessful ACR log responses', () => {
  assert.throws(
    () => verifyAcrBuildRevision({ Code: 'error', IsSuccess: false }, SHA),
    /Unable to read/u,
  );
  assert.throws(() => verifyAcrBuildRevision(logs(commitInfo(SHA)), '123456'), /invalid/u);
});
