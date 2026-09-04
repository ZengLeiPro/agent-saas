#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function verifyAcrBuildRevision(value, expectedSha) {
  const normalizedSha = String(expectedSha ?? '').toLowerCase();
  if (!SHA_PATTERN.test(normalizedSha)) throw new Error('Expected ACR source revision is invalid');
  if (value?.Code !== 'success' || value?.IsSuccess !== true)
    throw new Error('Unable to read the selected ACR build record log');

  const records = Array.isArray(value.BuildRecordLogs)
    ? value.BuildRecordLogs
    : value.BuildRecordLogs && typeof value.BuildRecordLogs === 'object'
      ? [value.BuildRecordLogs]
      : [];
  const cloneMessages = records
    .filter((record) => record?.BuildStage === 'GIT_CLONE')
    .map((record) => String(record.Message ?? ''))
    .join('\n')
    .toLowerCase();
  const match = cloneMessages.match(new RegExp(`(^|[^0-9a-f])${normalizedSha}([^0-9a-f]|$)`, 'u'));
  if (!match)
    throw new Error(
      `ACR build record is not bound to full source commit ${normalizedSha}; refusing the 6-character tag match`,
    );
  return normalizedSha;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [logsPath, expectedSha] = process.argv.slice(2);
  if (!logsPath || !expectedSha)
    throw new Error('usage: verify-acr-build-revision.mjs <build-record-logs.json> <full-sha>');
  const value = JSON.parse(await readFile(logsPath, 'utf8'));
  process.stdout.write(`${verifyAcrBuildRevision(value, expectedSha)}\n`);
}
