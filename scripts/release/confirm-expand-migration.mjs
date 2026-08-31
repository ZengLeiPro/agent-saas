#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { canonicalJson, digestBuffer, DIGEST_PATTERN } from './artifact-lib.mjs';

export const MAX_CONFIRMATION_DELAY_MS = 2 * 60 * 60 * 1000;
export const MAX_LIVE_READBACK_AGE_MS = 5 * 60 * 1000;

function timestamp(value, label) {
  const parsed = Date.parse(value ?? '');
  if (!Number.isFinite(parsed)) throw new Error(`${label} timestamp is invalid`);
  return parsed;
}

function targetComponents(manifest) {
  return {
    web: {
      gitSha: manifest.components.web.sourceSha,
      artifactDigest: manifest.components.web.artifactDigest,
    },
    api: {
      gitSha: manifest.components.api.sourceSha,
      artifactDigest: manifest.components.api.artifactDigest,
    },
    runtimeWorker: {
      gitSha: manifest.components.runtimeWorker.sourceSha,
      artifactDigest: manifest.components.runtimeWorker.artifactDigest,
    },
    acs: {
      gitSha: manifest.components.acs.sourceSha,
      orchestratorArtifactDigest: manifest.components.acs.orchestratorArtifactDigest,
      sandboxImageDigest: manifest.components.acs.sandboxImageDigest,
    },
  };
}

function parseReason(entry, label) {
  try {
    return JSON.parse(entry?.reason ?? '');
  } catch {
    throw new Error(`${label} attestation reason is not valid JSON`);
  }
}

export function confirmExpandMigration({
  manifest,
  attestations,
  live,
  apiReady,
  now = new Date(),
}) {
  if (manifest?.migrationPlan?.phase !== 'expand')
    throw new Error('Migration confirmation is only valid for an expand plan');
  if (manifest.migrationPlan.confirmation !== 'required_after_observation')
    throw new Error('Manifest does not require post-promotion migration confirmation');
  if (!DIGEST_PATTERN.test(manifest.migrationPlan.planDigest ?? ''))
    throw new Error('Manifest migration plan digest is invalid');
  if (!(now instanceof Date) || Number.isNaN(now.valueOf()))
    throw new Error('Confirmation time is invalid');
  if (!Array.isArray(attestations) || attestations.length === 0)
    throw new Error('Release attestation history is empty');
  const latest = attestations.at(-1);
  if (latest?.state !== 'awaiting_expand_confirmation')
    throw new Error(
      `Expand migration cannot be confirmed from ${String(latest?.state ?? 'unknown')}`,
    );
  const awaitingAt = timestamp(latest.recordedAt, 'Awaiting confirmation');
  if (now.valueOf() - awaitingAt > MAX_CONFIRMATION_DELAY_MS)
    throw new Error('Expand migration confirmation window expired');
  if (awaitingAt > now.valueOf() + 60_000)
    throw new Error('Awaiting confirmation timestamp is in the future');
  if (latest.releaseId !== manifest.releaseId || latest.manifestDigest !== manifest.digest)
    throw new Error('Latest attestation is not bound to the immutable RC Manifest');

  const promoting = attestations.findLast((entry) => entry?.state === 'promoting');
  if (!promoting) throw new Error('Promotion start attestation is missing');
  const binding = parseReason(promoting, 'Promoting');
  if (
    binding.releaseId !== manifest.releaseId ||
    binding.releaseSha !== manifest.releaseSha ||
    binding.manifestDigest !== manifest.digest ||
    binding.migrationPhase !== 'expand' ||
    binding.migrationPlanDigest !== manifest.migrationPlan.planDigest
  ) {
    throw new Error('Promotion attestation is not bound to the release and migration plan');
  }

  if (
    apiReady?.status !== 'ok' ||
    apiReady?.release?.environment !== 'production' ||
    apiReady.release.safetyAttested !== true ||
    apiReady.release.releaseId !== manifest.releaseId ||
    apiReady.release.releaseSha !== manifest.releaseSha
  ) {
    throw new Error('Production API migration/readiness readback is not bound to the RC');
  }
  if (live?.schemaVersion !== 1 || live?.environment !== 'production')
    throw new Error('Production live readback is invalid');
  const liveObservedAt = timestamp(live.observedAt, 'Production live readback');
  if (now.valueOf() - liveObservedAt > MAX_LIVE_READBACK_AGE_MS)
    throw new Error('Production live readback is stale');
  if (liveObservedAt > now.valueOf() + 60_000)
    throw new Error('Production live readback timestamp is in the future');
  const target = targetComponents(manifest);
  if (canonicalJson(live.components) !== canonicalJson(target))
    throw new Error('Production component baseline drifted from the promoted target');
  const targetDigest = digestBuffer(canonicalJson(target));
  if (binding.productionTargetDigest !== targetDigest)
    throw new Error('Promotion target digest does not match the current Manifest');
  if (!DIGEST_PATTERN.test(binding.productionBeforeDigest ?? ''))
    throw new Error('Promotion attestation lacks a valid production baseline digest');

  return {
    schemaVersion: 1,
    releaseId: manifest.releaseId,
    manifestDigest: manifest.digest,
    migrationPlanDigest: manifest.migrationPlan.planDigest,
    productionBeforeDigest: binding.productionBeforeDigest,
    productionTargetDigest: targetDigest,
    liveObservedAt: live.observedAt,
    apiReadyReleaseId: apiReady.release.releaseId,
    apiReadyReleaseSha: apiReady.release.releaseSha,
    confirmedAt: now.toISOString(),
    status: 'completed',
  };
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
  const args = parse(process.argv);
  if (!args.manifest || !args.attestations || !args.live || !args['api-ready'] || !args.output)
    throw new Error(
      'usage: confirm-expand-migration.mjs --manifest <json> --attestations <jsonl> --live <json> --api-ready <json> --output <json>',
    );
  const [manifest, attestationText, live, apiReady] = await Promise.all([
    readFile(args.manifest, 'utf8').then(JSON.parse),
    readFile(args.attestations, 'utf8'),
    readFile(args.live, 'utf8').then(JSON.parse),
    readFile(args['api-ready'], 'utf8').then(JSON.parse),
  ]);
  const attestations = attestationText
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const evidence = confirmExpandMigration({ manifest, attestations, live, apiReady });
  await writeFile(args.output, `${canonicalJson(evidence)}\n`, { flag: 'wx' });
  process.stdout.write(`${canonicalJson(evidence)}\n`);
}
