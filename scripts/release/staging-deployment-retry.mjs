import { readFileSync } from 'node:fs';

/** Reuse the original GitHub deployment, so append-only verified evidence stays truthful. */
export function retryDeployment(history, releaseId, digest, runId) {
  if (!Array.isArray(history) || !history.length) throw new Error('Missing attestation history');
  if (history.some((entry) => entry.releaseId !== releaseId || entry.manifestDigest !== digest))
    throw new Error('Attestation release binding mismatch');
  if (!['built', 'staging_deployed', 'verified'].includes(history.at(-1).state))
    throw new Error('Cannot redeploy a release after promotion has started');
  const deployed = history.findLast((entry) => entry.state === 'staging_deployed');
  if (!deployed) {
    if (history.at(-1).state !== 'built') throw new Error('Missing staging deployment evidence');
    return '';
  }
  const reason = JSON.parse(deployed.reason);
  if (
    reason.manifestDigest !== digest ||
    reason.stagingRunId !== String(runId) ||
    !/^[1-9][0-9]*$/.test(reason.stagingDeploymentId)
  )
    throw new Error('Staging retry must retain the same run and deployment identity');
  return reason.stagingDeploymentId;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , path, release, digest, run] = process.argv;
  const history = readFileSync(path, 'utf8').trim().split(/\r?\n/u).map(JSON.parse);
  process.stdout.write(retryDeployment(history, release, digest, run));
}
