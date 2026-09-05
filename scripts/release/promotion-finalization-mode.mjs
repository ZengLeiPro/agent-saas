#!/usr/bin/env node
import { readFileSync } from 'node:fs';

export function promotionFinalizationMode({ manifest, attestations, runId }) {
  const latest = attestations.at(-1);
  if (!latest || !['awaiting_expand_confirmation', 'completed'].includes(latest.state)) {
    return 'promote';
  }
  if (
    manifest?.migrationPlan?.phase !== 'expand' ||
    manifest.migrationPlan.confirmation !== 'required_after_observation' ||
    latest.releaseId !== manifest.releaseId ||
    latest.manifestDigest !== manifest.digest
  ) {
    throw new Error('Automatic finalization requires an expand attestation bound to this RC');
  }
  if (latest.state === 'awaiting_expand_confirmation') return 'confirm';
  if (
    !/^[1-9][0-9]*$/u.test(String(runId)) ||
    !new RegExp('^expand-confirmation:' + runId + ':[1-9][0-9]*$').test(latest.operationKey)
  ) {
    throw new Error('Release was already confirmed by another workflow run');
  }
  return 'repair';
}

export function finalizationDeploymentId(attestations) {
  const awaiting = attestations.findLast((entry) => entry.state === 'awaiting_expand_confirmation');
  const reason = JSON.parse(awaiting?.reason ?? '{}');
  const id = reason.productionDeploymentId ?? '';
  if (id !== '' && (typeof id !== 'string' || !/^[1-9][0-9]*$/u.test(id))) {
    throw new Error('Invalid Production Deployment ID in the finalization attestation');
  }
  return id;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [manifestPath, attestationsPath, runId, output] = process.argv.slice(2);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const attestations = readFileSync(attestationsPath, 'utf8')
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map(JSON.parse);
  const mode = promotionFinalizationMode({ manifest, attestations, runId });
  if (output && output !== '--deployment-id') throw new Error('Unknown finalization output');
  process.stdout.write((output ? finalizationDeploymentId(attestations) : mode) + '\n');
}
