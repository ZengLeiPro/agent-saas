#!/usr/bin/env node
// Consume one trusted main-push run without changing the persisted release-evidence schema.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const workflowPath = '.github/workflows/ci.yml';
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

export function buildUnifiedCiEvidence({ workflow, initialRun, finalRun, pages, sha, repository }) {
  assert(/^[a-f0-9]{40}$/u.test(sha), 'Expected a full release SHA');
  assert(
    typeof repository === 'string' && /^[^/]+\/[^/]+$/u.test(repository),
    'Expected repository identity',
  );
  assert(workflow?.path === workflowPath && positiveInteger(workflow.id), 'Untrusted CI workflow');
  for (const run of [initialRun, finalRun]) {
    assert(
      run && positiveInteger(run.id) && positiveInteger(run.run_attempt),
      'Invalid CI run identity',
    );
    assert(
      run.workflow_id === workflow.id && run.path === workflowPath,
      'CI workflow identity mismatch',
    );
    assert(
      run.repository?.full_name === repository && run.head_repository?.full_name === repository,
      'CI repository identity mismatch',
    );
    assert(
      run.event === 'push' && run.head_branch === 'main' && run.head_sha === sha,
      'CI must be a same-SHA main push',
    );
    assert(run.status === 'completed' && run.conclusion === 'success', 'CI run is not successful');
  }
  assert(
    finalRun.id === initialRun.id && finalRun.run_attempt === initialRun.run_attempt,
    'CI run attempt changed while collecting evidence; retry Staging',
  );
  assert(Array.isArray(pages) && pages.length > 0, 'Missing CI jobs pages');
  const total = pages[0].total_count;
  assert(positiveInteger(total), 'Missing CI jobs count');
  const jobs = pages.flatMap((page) => {
    assert(
      page.total_count === total && Array.isArray(page.jobs),
      'Inconsistent CI jobs pagination',
    );
    return page.jobs;
  });
  assert(jobs.length === total, 'Incomplete CI jobs pagination');
  assert(
    jobs.every((job) => positiveInteger(job.id)) &&
      new Set(jobs.map((job) => job.id)).size === total,
    'Duplicate or invalid CI jobs',
  );
  const result = {};
  for (const [key, name] of [
    ['appCi', 'Build & Check'],
    ['acsImpact', 'ACS Impact Gate'],
  ]) {
    const matches = jobs.filter((job) => job.name === name);
    assert(matches.length === 1, `Expected exactly one ${name} job`);
    const job = matches[0];
    assert(
      job.run_id === initialRun.id && job.head_sha === sha,
      `${name} belongs to another run/SHA`,
    );
    // filter=latest intentionally carries successful jobs when only failed jobs are rerun.
    assert(
      positiveInteger(job.run_attempt) && job.run_attempt <= finalRun.run_attempt,
      `${name} has an invalid run attempt`,
    );
    assert(job.status === 'completed' && job.conclusion === 'success', `${name} is not successful`);
    result[key] = { workflow: name, status: 'success', headSha: sha, runId: initialRun.id };
  }
  return result;
}

function main() {
  const [workflowFile, initialFile, pagesFile, finalFile, sha, repository, ...extra] =
    process.argv.slice(2);
  assert(
    workflowFile &&
      initialFile &&
      pagesFile &&
      finalFile &&
      sha &&
      repository &&
      extra.length === 0,
    'Usage: unified-ci-evidence.mjs <workflow.json> <initial-run.json> <jobs-pages.json> <final-run.json> <sha> <owner/repo>',
  );
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  const evidence = buildUnifiedCiEvidence({
    workflow: read(workflowFile),
    initialRun: read(initialFile),
    pages: read(pagesFile),
    finalRun: read(finalFile),
    sha,
    repository,
  });
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Unified CI evidence rejected: ${error.message}\n`);
    process.exitCode = 1;
  }
}
