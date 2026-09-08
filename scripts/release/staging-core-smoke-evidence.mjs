import { readFile } from 'node:fs/promises';
import { canonicalJson, digestBuffer, DIGEST_PATTERN, SHA_PATTERN } from './artifact-lib.mjs';

export const CORE_SMOKE_CHECKS = ['login', 'authenticated-read', 'persistence-read', 'websocket'];

export function validateCoreSmokeEvidence(value, expected, now = Date.now()) {
  if (
    value?.schemaVersion !== 1 ||
    value.status !== 'passed' ||
    value.environment !== 'staging' ||
    !/^rc-\d{8}-\d{2,}$/u.test(value.releaseId ?? '') ||
    !SHA_PATTERN.test(value.sourceSha ?? '') ||
    !DIGEST_PATTERN.test(value.manifestDigest ?? '') ||
    !/^[1-9][0-9]*$/u.test(value.stagingRunId ?? '') ||
    !/^[1-9][0-9]*$/u.test(value.stagingRunAttempt ?? '') ||
    value.actor !== 'staging-e2e-admin' ||
    JSON.stringify(value.checks) !== JSON.stringify(CORE_SMOKE_CHECKS)
  )
    throw new Error('Core business smoke evidence is incomplete');
  for (const key of [
    'releaseId',
    'manifestDigest',
    'sourceSha',
    'stagingRunId',
    'stagingRunAttempt',
  ]) {
    if (value[key] !== String(expected[key]))
      throw new Error(`Core business smoke ${key} binding mismatch`);
  }
  const { evidenceDigest, ...body } = value;
  if (evidenceDigest !== digestBuffer(Buffer.from(canonicalJson(body))))
    throw new Error('Core business smoke digest mismatch');
  const observed = Date.parse(value.observedAt);
  if (!Number.isFinite(observed) || observed > now + 60_000 || now - observed > 24 * 60 * 60_000)
    throw new Error('Core business smoke is stale or has an invalid observation time');
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , path, manifestPath, run, attempt] = process.argv;
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const evidence = JSON.parse(await readFile(path, 'utf8'));
  validateCoreSmokeEvidence(evidence, {
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    sourceSha: manifest.releaseSha,
    stagingRunId: run,
    stagingRunAttempt: attempt,
  });
  process.stdout.write(
    `${JSON.stringify({ status: 'passed', evidenceDigest: evidence.evidenceDigest })}\n`,
  );
}
