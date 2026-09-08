import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// GitHub's rerun-failed-jobs retains successful jobs and their immutable artifacts.
// Trust the actual successful package job attempt, bounded by the successful run.
export async function selectPreparedReleaseArtifact({
  artifacts,
  sha,
  runId,
  runAttempt,
  jobsForAttempt,
}) {
  assert.match(sha, /^[a-f0-9]{40}$/u);
  assert.ok(
    Number.isSafeInteger(runId) && runId > 0 && Number.isSafeInteger(runAttempt) && runAttempt > 0,
  );
  const prefix = `release-packages-${sha}-${runId}-`;
  const candidates = artifacts
    .filter((artifact) => artifact.name?.startsWith(prefix) && !artifact.expired)
    .map((artifact) => ({ ...artifact, attempt: Number(artifact.name.slice(prefix.length)) }))
    .filter(
      (artifact) =>
        Number.isSafeInteger(artifact.attempt) &&
        artifact.attempt > 0 &&
        artifact.attempt <= runAttempt &&
        artifact.name === `${prefix}${artifact.attempt}`,
    )
    .sort((a, b) => b.attempt - a.attempt);
  for (const artifact of candidates) {
    assert.equal(
      candidates.filter((entry) => entry.name === artifact.name).length,
      1,
      'Ambiguous prepared artifact',
    );
    assert.equal(artifact.workflow_run?.id, runId, 'Artifact belongs to another CI run');
    assert.equal(artifact.workflow_run?.head_sha, sha, 'Artifact belongs to another source');
    const jobs = await jobsForAttempt(artifact.attempt);
    const producers = jobs.filter(
      (job) =>
        job.name === '预检 / 真实发布包' &&
        job.run_id === runId &&
        job.run_attempt === artifact.attempt,
    );
    assert.equal(producers.length, 1, 'Missing or ambiguous package producer job');
    const job = producers[0];
    if (job.status !== 'completed' || job.conclusion !== 'success') continue;
    assert.ok(
      job.steps?.some(
        (step) => step.name === '保存可信 main 发布包' && step.conclusion === 'success',
      ),
      'Package producer did not successfully publish the artifact',
    );
    return { name: artifact.name, runAttempt: artifact.attempt };
  }
  throw new Error(
    'No verified package artifact remains. Re-run all APP CI jobs for this SHA (artifacts expire after seven days), then retry Staging.',
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [repository, sha, id, attempt, artifactFile, output] = process.argv.slice(2);
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/u);
  const pages = JSON.parse(await readFile(artifactFile, 'utf8'));
  const selected = await selectPreparedReleaseArtifact({
    artifacts: pages.flatMap((page) => page.artifacts),
    sha,
    runId: Number(id),
    runAttempt: Number(attempt),
    jobsForAttempt: async (producerAttempt) =>
      JSON.parse(
        execFileSync(
          'gh',
          [
            'api',
            '--paginate',
            '--slurp',
            `repos/${repository}/actions/runs/${id}/attempts/${producerAttempt}/jobs?per_page=100`,
          ],
          { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        ),
      ).flatMap((page) => page.jobs),
  });
  await appendFile(
    output,
    `PREPARED_ARTIFACT_NAME=${selected.name}\nPREPARED_RUN_ATTEMPT=${selected.runAttempt}\n`,
  );
  console.log(JSON.stringify(selected));
}
