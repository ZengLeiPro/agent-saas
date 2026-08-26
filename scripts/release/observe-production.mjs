#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const REQUIRED_CHECKS = Object.freeze([
  'http',
  'websocket',
  'agentFirstToken',
  'agentCompletion',
  'runRecovery',
  'workerLease',
  'integrationReleaseGate',
  'sandboxLifecycle',
  'cronDeduplication',
  'login',
  'sessionRead',
  'taskboardRead',
]);

export function evaluateObservationSamples(samples, releaseId, manifestDigest) {
  if (!Array.isArray(samples) || samples.length === 0)
    return { ok: false, blockingReasons: ['Production observation has no samples.'] };
  const blockingReasons = [];
  let previousObservedAt = 0;
  for (const [index, sample] of samples.entries()) {
    if (sample.releaseId !== releaseId || sample.manifestDigest !== manifestDigest)
      blockingReasons.push(`sample ${index + 1} is not bound to the promoted release`);
    const observedAt = Date.parse(sample.observedAt ?? '');
    if (!Number.isFinite(observedAt) || observedAt <= previousObservedAt)
      blockingReasons.push(`sample ${index + 1} does not have a fresh increasing observedAt`);
    else previousObservedAt = observedAt;
    for (const check of REQUIRED_CHECKS) {
      if (sample.checks?.[check]?.status !== 'ok')
        blockingReasons.push(`sample ${index + 1} check ${check} is not ok`);
    }
    const httpErrorRate = Number(sample.metrics?.httpErrorRate);
    if (!Number.isFinite(httpErrorRate) || httpErrorRate < 0 || httpErrorRate > 0.01)
      blockingReasons.push(
        `sample ${index + 1} HTTP error rate is missing, invalid, or exceeded 1%`,
      );
    const duplicateExecutions = Number(sample.metrics?.duplicateExecutions);
    if (!Number.isSafeInteger(duplicateExecutions) || duplicateExecutions !== 0)
      blockingReasons.push(`sample ${index + 1} observed duplicate execution`);
  }
  return { ok: blockingReasons.length === 0, blockingReasons };
}

function options(argv) {
  const output = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value) throw new Error('Every option requires a value');
    output[key.slice(2)] = value;
  }
  return output;
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = options(process.argv);
  const durationMs = Number(args['duration-ms'] ?? 15 * 60_000);
  const intervalMs = Number(args['interval-ms'] ?? 30_000);
  if (!args.url || !args['release-id'] || !args['manifest-digest'] || !args.output)
    throw new Error('url, release-id, manifest-digest and output are required');
  if (durationMs < 15 * 60_000 || intervalMs < 10_000)
    throw new Error('Production observation must cover at least 15 minutes with bounded polling');
  const token = args['token-file'] ? (await readFile(args['token-file'], 'utf8')).trim() : '';
  const samples = [];
  const deadline = Date.now() + durationMs;
  do {
    const url = new URL(args.url);
    url.searchParams.set('releaseId', args['release-id']);
    const response = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(`Production observation endpoint returned ${response.status}`);
    const sample = await response.json();
    samples.push({ ...sample, collectedAt: new Date().toISOString() });
    if (Date.now() < deadline) await sleep(Math.min(intervalMs, deadline - Date.now()));
  } while (Date.now() < deadline);
  const evaluation = evaluateObservationSamples(
    samples,
    args['release-id'],
    args['manifest-digest'],
  );
  const report = {
    schemaVersion: 1,
    releaseId: args['release-id'],
    manifestDigest: args['manifest-digest'],
    startedAt: samples[0]?.collectedAt ?? null,
    completedAt: samples.at(-1)?.collectedAt ?? null,
    sampleCount: samples.length,
    ...evaluation,
    conclusions: {
      gitRefRc: 'separate_evidence_required',
      ci: 'separate_evidence_required',
      stagingDeployment: 'separate_evidence_required',
      e2e: 'separate_evidence_required',
      humanAcceptance: 'approval_attestation_required',
      productionComponents: evaluation.ok ? 'observed' : 'blocked',
      healthAndContinuousProbes: evaluation.ok ? 'passed' : 'failed',
      businessAcceptance: 'separate_evidence_required',
    },
  };
  await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!evaluation.ok) process.exitCode = 1;
}
