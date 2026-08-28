#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalJson } from './artifact-lib.mjs';
import { validateReleaseEvidenceDocument } from './release-evidence-schema.mjs';

function evidenceUrl(value, releaseSha) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname))
  ) {
    throw new Error('Release Evidence URL must use HTTPS without embedded credentials');
  }
  url.searchParams.set('sha', releaseSha);
  return url;
}

async function responseJson(response, label) {
  const text = await response.text();
  if (!response.ok)
    throw new Error(`${label} failed with HTTP ${response.status}: ${text.slice(0, 512)}`);
  return JSON.parse(text);
}

export async function publishReleaseEvidence(
  { evidence, url, readToken, writeToken },
  fetchImpl = fetch,
) {
  const validated = validateReleaseEvidenceDocument(evidence);
  if (!readToken || !writeToken || readToken === writeToken) {
    throw new Error('Separate Release Evidence read and write tokens are required');
  }
  const target = evidenceUrl(url, validated.releaseSha);
  const created = await responseJson(
    await fetchImpl(target, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${writeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(validated),
      signal: AbortSignal.timeout(15_000),
    }),
    'Release Evidence write',
  );
  if (canonicalJson(created) !== canonicalJson(validated)) {
    throw new Error('Release Evidence POST response differs from the generated document');
  }
  const readBack = await responseJson(
    await fetchImpl(target, {
      headers: { authorization: `Bearer ${readToken}` },
      signal: AbortSignal.timeout(15_000),
    }),
    'Release Evidence readback',
  );
  if (canonicalJson(readBack) !== canonicalJson(validated)) {
    throw new Error('Release Evidence readback differs from the generated document');
  }
  return validated;
}

function parse(argv) {
  const values = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    values[key.slice(2)] = value;
  }
  return values;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const options = parse(process.argv);
  if (!options.input || !options.url) {
    throw new Error(
      'usage: publish-release-evidence.mjs --input <evidence.json> --url <https-url>',
    );
  }
  const evidence = JSON.parse(await readFile(resolve(options.input), 'utf8'));
  const value = await publishReleaseEvidence({
    evidence,
    url: options.url,
    readToken: process.env.RELEASE_EVIDENCE_READ_TOKEN,
    writeToken: process.env.RELEASE_EVIDENCE_WRITE_TOKEN,
  });
  process.stdout.write(`${value.evidenceDigest}\n`);
}
