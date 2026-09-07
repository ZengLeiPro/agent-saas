import { execFileSync } from 'node:child_process';

/** Sort attempts by status time, not deployment creation time: old IDs can be retried. */
export function assertLatestStagingAttempt(entries, releaseId) {
  const attempts = entries.flatMap(({ deployment, statuses }) =>
    statuses
      .filter((status) => status.state !== 'inactive')
      .map((status) => ({ deployment, status })),
  );
  if (
    attempts.some(
      ({ status }) =>
        !Number.isFinite(Date.parse(status.created_at)) || !Number.isSafeInteger(status.id),
    )
  )
    throw new Error('Invalid Staging attempt status');
  attempts.sort(
    (a, b) =>
      Date.parse(b.status.created_at) - Date.parse(a.status.created_at) ||
      b.status.id - a.status.id,
  );
  const latest = attempts[0];
  // Creation can succeed while publishing the first status fails. Such a newer attempt
  // must not fall back to an older success. Missing history is intentionally fail closed.
  if (
    entries.some(
      ({ deployment, statuses }) =>
        !statuses.length &&
        (!latest ||
          !Number.isFinite(Date.parse(deployment.created_at)) ||
          Date.parse(deployment.created_at) >= Date.parse(latest.status.created_at)),
    )
  )
    throw new Error('Staging deployment has no status; acceptance blocked');
  if (
    !latest ||
    latest.deployment.environment !== 'staging' ||
    latest.deployment.payload?.releaseId !== releaseId ||
    latest.status.state !== 'success'
  )
    throw new Error(
      'Latest Staging attempt is incomplete or belongs to another RC; acceptance blocked',
    );
  return { deploymentId: latest.deployment.id, statusId: latest.status.id };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , repository, releaseId] = process.argv;
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? '')) throw new Error('Invalid repository');
  const api = (path) =>
    JSON.parse(
      execFileSync('gh', ['api', '--paginate', '--slurp', path], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60000,
      }),
    ).flat();
  const deployments = api(`repos/${repository}/deployments?environment=staging&per_page=100`);
  const entries = deployments.map((deployment) => ({
    deployment,
    statuses: api(`repos/${repository}/deployments/${deployment.id}/statuses?per_page=100`),
  }));
  process.stdout.write(JSON.stringify(assertLatestStagingAttempt(entries, releaseId)));
}
