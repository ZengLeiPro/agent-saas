#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
// ACR 自动构建的 fetch 阶段只打印一行 `commit info:\t* <branch> <缩写 SHA> [origin/<branch>] <subject>`，
// 缩写 SHA 由 ACR 决定（当前 7 位），日志中不会出现 40 位完整 SHA。
const COMMIT_INFO_PATTERN = /^\s*commit info:\s*\*?\s*(\S+)\s+([0-9a-f]{7,40})\b/iu;
const MIN_ABBREVIATED_LENGTH = 7;

export function verifyAcrBuildRevision(value, expectedSha, options = {}) {
  const normalizedSha = String(expectedSha ?? '').toLowerCase();
  if (!SHA_PATTERN.test(normalizedSha)) throw new Error('Expected ACR source revision is invalid');
  if (value?.Code !== 'success' || value?.IsSuccess !== true)
    throw new Error('Unable to read the selected ACR build record log');

  const records = Array.isArray(value.BuildRecordLogs)
    ? value.BuildRecordLogs
    : value.BuildRecordLogs && typeof value.BuildRecordLogs === 'object'
      ? [value.BuildRecordLogs]
      : [];
  const commitInfos = records
    .map((record) => String(record?.Message ?? '').match(COMMIT_INFO_PATTERN))
    .filter(Boolean)
    .map((match) => ({ branch: match[1], abbreviatedSha: match[2].toLowerCase() }));
  if (commitInfos.length === 0)
    throw new Error(
      `ACR build record log has no fetch-stage commit info; cannot bind the image to source commit ${normalizedSha}`,
    );
  const expectedBranch = options.branch == null ? null : String(options.branch);
  for (const { branch, abbreviatedSha } of commitInfos) {
    if (abbreviatedSha.length < MIN_ABBREVIATED_LENGTH || !normalizedSha.startsWith(abbreviatedSha))
      throw new Error(
        `ACR build record cloned ${abbreviatedSha} (${branch}), not source commit ${normalizedSha}; refusing the six-character tag match`,
      );
    if (expectedBranch !== null && branch !== expectedBranch)
      throw new Error(
        `ACR build record cloned branch ${branch}, expected ${expectedBranch} for source commit ${normalizedSha}`,
      );
  }
  return normalizedSha;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [logsPath, expectedSha, branch] = process.argv.slice(2);
  if (!logsPath || !expectedSha)
    throw new Error('usage: verify-acr-build-revision.mjs <build-record-logs.json> <full-sha> [branch]');
  const value = JSON.parse(await readFile(logsPath, 'utf8'));
  process.stdout.write(`${verifyAcrBuildRevision(value, expectedSha, { branch })}\n`);
}
