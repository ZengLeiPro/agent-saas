#!/usr/bin/env node
import { readFile, realpath } from 'node:fs/promises';

const RELEASE_ID_PATTERN = /^rc-\d{8}-\d{2,}$/u;
const TOKEN_PATH = '/etc/agent-saas-staging/release-evidence-write.token';

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

const [environment, releaseId, inputPath] = process.argv.slice(2);
if (environment !== 'staging' || !RELEASE_ID_PATTERN.test(releaseId ?? '') || !inputPath) {
  throw new Error('usage: publish-isolation-evidence.mjs staging <release-id> <evidence.json>');
}
const resolvedInput = await realpath(inputPath);
if (!resolvedInput.startsWith('/tmp/agent-saas-staging-')) {
  throw new Error('Isolation evidence input is outside the Staging transfer directory');
}
const [token, input] = await Promise.all([
  readFile(TOKEN_PATH, 'utf8').then((value) => value.trim()),
  readFile(resolvedInput, 'utf8').then(JSON.parse),
]);
if (input.releaseId !== releaseId || input.environment !== 'staging') {
  throw new Error('Isolation evidence identity does not match the requested Staging release');
}
const url = new URL('http://127.0.0.1:3420/staging-isolation');
url.searchParams.set('releaseId', releaseId);
const response = await fetch(url, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(input),
  signal: AbortSignal.timeout(15_000),
});
const body = await response.json().catch(() => ({}));
if (response.status !== 201 || canonicalJson(body) !== canonicalJson(input)) {
  throw new Error(`Unable to publish immutable Staging isolation evidence: ${response.status}`);
}
process.stdout.write(`${JSON.stringify({ releaseId, status: 'published' })}\n`);
