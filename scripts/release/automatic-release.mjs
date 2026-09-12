#!/usr/bin/env node
import assert from 'node:assert/strict';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stagingBinding } from './staging-deployment-binding.mjs';
import { readEvidenceJson } from './evidence-file.mjs';
import { AutomaticGitHub } from './automatic-release-github.mjs';
import { AutomaticLedger } from './automatic-release-ledger.mjs';
import {
  assertRun,
  assertStep,
  requireAutomatic,
  STEP_TASK,
} from './automatic-release-contract.mjs';
import { createRequest, planRequest } from './automatic-release-plan.mjs';
import { isAncestor, loadCatalog, readRelease } from './automatic-release-catalog.mjs';
import { assertParentLive, runChild } from './automatic-release-dispatch.mjs';
import { downloadResult, productionResult } from './automatic-release-result.mjs';

const save = (directory, name, value) =>
  writeFile(join(directory, name), JSON.stringify(value, null, 2) + '\n');
const productionInputs = (releaseId, reason, operation = 'promote') => ({
  operation,
  release_id: releaseId,
  recovery_mode: 'normal',
  reason,
});

/** No SSH, cloud credentials or deployment logic here: existing guarded workers remain authoritative. */
export async function executeAutomaticRelease({
  client,
  run,
  reason,
  directory,
  signal,
  ledger = new AutomaticLedger(client),
  catalog = loadCatalog,
  ancestor = isAncestor,
  child = runChild,
  readProduction = productionResult,
  readCandidate = readRelease,
  readStaging = downloadResult,
  parentLive = assertParentLive,
  now = Date.now,
}) {
  await mkdir(directory, { recursive: true });
  assertRun(run, client.repository, 'promote-release.yml');
  assert(run.status === 'in_progress' && run.run_attempt >= 1);
  requireAutomatic(
    typeof reason === 'string' && reason.trim() && reason.length <= 2048,
    'invalid_reason',
    '请输入不超过 2048 字的发布原因。',
  );
  const deadline = now() + 350 * 60 * 1000;
  let releases = await catalog(client, directory, now());
  const record = await ledger.request(
    run,
    () =>
      createRequest({
        run,
        reason,
        releases,
        repository: client.repository,
        isAncestor: ancestor,
      }),
    client.repository,
  );
  const request = record.payload;
  await save(directory, 'request.json', record);
  const results = [];
  const dispatch = async (stage, workflow, sourceSha, inputs) => {
    let result;
    try {
      result = await child({
        client,
        ledger,
        requestRecord: record,
        parentAttempt: run.run_attempt,
        stage,
        workflow,
        sourceSha,
        inputs,
        deadline,
        signal,
        now,
      });
    } catch (error) {
      await save(directory, 'child-failure.json', {
        schemaVersion: 1,
        requestDigest: request.digest,
        targetSourceSha: request.target.sourceSha,
        stage,
        parentRunId: String(run.id),
        parentRunAttempt: run.run_attempt,
        ...(error.automaticRelease ?? {}),
        rejection: error.code ?? 'validation_failed',
        recordedAt: new Date(now()).toISOString(),
      });
      throw error;
    }
    results.push({
      stage,
      runId: result.run.id,
      url: result.run.html_url,
      sourceSha,
      releaseId: inputs.release_id ?? null,
    });
    await save(directory, 'children.json', results);
    return result.run;
  };
  const checkpoint = async (candidate, stage) => {
    const childRun = await dispatch(
      stage,
      'promote-release.yml',
      candidate.manifest.releaseSha,
      productionInputs(candidate.manifest.releaseId, request.reason, 'checkpoint-repair'),
    );
    const result = await readProduction(
      client,
      childRun,
      directory,
      candidate.manifest.releaseSha,
      candidate.manifest.releaseId,
    );
    requireAutomatic(
      !result.checkpointPending,
      'checkpoint_unverified',
      '发布组件已提交，但派生基线尚未验证完成。',
    );
    return result;
  };
  try {
    await ledger.status(
      record,
      'in_progress',
      'Pinned target; recovery is not final success',
      run.id,
    );
    let plan = planRequest(request, releases, { isAncestor: ancestor, now: now() });
    await save(directory, 'plan.json', {
      target: request.target,
      recoveryReleaseId: plan.recovery?.manifest.releaseId ?? null,
      refreshRequired: plan.needsRefresh,
    });
    console.log(`本次固定目标 ${request.target.sourceSha}（原候选 ${request.target.releaseId}）`);
    if (plan.recovery) {
      const old = plan.recovery;
      const childRun = await dispatch(
        'recover',
        'promote-release.yml',
        old.manifest.releaseSha,
        productionInputs(old.manifest.releaseId, request.reason),
      );
      const result = await readProduction(
        client,
        childRun,
        directory,
        old.manifest.releaseSha,
        old.manifest.releaseId,
      );
      if (result.checkpointPending) await checkpoint(old, `recover-checkpoint-${run.run_attempt}`);
      releases = await catalog(client, directory, now());
      plan = planRequest(request, releases, { isAncestor: ancestor, now: now() });
      requireAutomatic(
        !plan.recovery,
        'recovery_not_closed',
        '旧事务尚未闭合，不能继续准备目标版本。',
      );
    }
    // A resumed parent must reattach the immutable previous child, not create a different target.
    const previous = await ledger.records(STEP_TASK, run.id);
    const publishes = previous.filter((r) => r.payload.stage === 'publish');
    const refreshes = previous.filter((r) => r.payload.stage === 'refresh');
    assert(publishes.length <= 1 && refreshes.length <= 1);
    let candidate = plan.target;
    if (publishes.length) {
      const step = assertStep(publishes[0], request);
      candidate = await readCandidate(client, step.inputs.release_id, directory, now());
    } else if (refreshes.length || plan.needsRefresh) {
      const stagingRun = await dispatch('refresh', 'deploy-staging.yml', request.target.sourceSha, {
        reason: request.reason,
      });
      const out = await readStaging(client, stagingRun, directory, 'staging-evidence-');
      const manifest = await readEvidenceJson(join(out, 'manifest.json'), 1048576);
      assert.equal(manifest.releaseSha, request.target.sourceSha);
      candidate = await readCandidate(client, manifest.releaseId, directory, now());
      assert.equal(candidate.manifest.digest, manifest.digest);
      assert.equal(candidate.state, 'verified', 'Refresh must finish the full Staging acceptance');
      const binding = stagingBinding(candidate.manifest, candidate.history);
      assert.equal(binding.stagingRunId, String(stagingRun.id));
      assert.equal(binding.stagingRunAttempt, String(stagingRun.run_attempt));
    }
    assert.equal(
      candidate.manifest.releaseSha,
      request.target.sourceSha,
      'Frozen target cannot drift',
    );
    requireAutomatic(
      !['revoked', 'rejected', 'rolled_back'].includes(candidate.state),
      'candidate_revoked',
      '目标候选已撤销，不能继续。',
    );
    if (candidate.state !== 'completed') {
      const childRun = await dispatch(
        'publish',
        'promote-release.yml',
        request.target.sourceSha,
        productionInputs(candidate.manifest.releaseId, request.reason),
      );
      const result = await readProduction(
        client,
        childRun,
        directory,
        request.target.sourceSha,
        candidate.manifest.releaseId,
      );
      // A green worker with a checkpoint warning is NOT a fulfilled automatic request.
      await save(directory, 'publication.json', result);
    }
    await parentLive(client, request, run.run_attempt);
    // Fresh readback on EACH parent attempt; never treat a stale successful child as current truth.
    const result = await checkpoint(candidate, `verify-${run.run_attempt}`);
    assert.equal(result.sourceSha, request.target.sourceSha);
    const final = {
      schemaVersion: 1,
      status: 'completed',
      requestDigest: request.digest,
      targetSourceSha: request.target.sourceSha,
      ...result,
      checkedAt: new Date(now()).toISOString(),
    };
    await save(directory, 'result.json', final);
    await ledger.status(
      record,
      'success',
      `Target ${result.sourceSha.slice(0, 12)} verified`,
      run.id,
    );
    return final;
  } catch (error) {
    await save(directory, 'result.json', {
      schemaVersion: 1,
      status: 'blocked',
      requestDigest: request.digest,
      targetSourceSha: request.target.sourceSha,
      check: error.code ?? 'validation_failed',
      checkedAt: new Date(now()).toISOString(),
    });
    try {
      await ledger.status(
        record,
        'failure',
        `Blocked: ${error.code ?? 'validation_failed'}`,
        run.id,
      );
    } catch {
      /* Preserve the primary failure; never print token-bearing subprocess errors. */
    }
    throw error;
  }
}

async function main(env = process.env) {
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_REF, 'refs/heads/main');
  const event = await readEvidenceJson(env.GITHUB_EVENT_PATH, 1048576);
  assert.equal(event.inputs?.operation, 'auto');
  const controller = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => controller.abort());
  const client = new AutomaticGitHub(env.GITHUB_REPOSITORY, { signal: controller.signal });
  const run = await client.api(`actions/runs/${env.GITHUB_RUN_ID}`);
  assert.equal(run.head_sha, env.GITHUB_SHA);
  assert.equal(String(run.run_attempt), env.GITHUB_RUN_ATTEMPT);
  const result = await executeAutomaticRelease({
    client,
    run,
    reason: event.inputs.reason,
    directory: join(env.RUNNER_TEMP, 'automatic-release'),
    signal: controller.signal,
  });
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(
      env.GITHUB_STEP_SUMMARY,
      `## 自动发布完成\n\n目标源码：\`${result.sourceSha}\`\n\n最终 RC：\`${result.releaseId}\`\n\n已核验目标组件矩阵和持久化 checkpoint；不是仅恢复旧版。\n`,
    );
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    // Selection/API failures before a request reservation still need a transferable diagnosis.
    const directory = join(process.env.RUNNER_TEMP ?? '.', 'automatic-release');
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(
        join(directory, 'result.json'),
        JSON.stringify({
          schemaVersion: 1,
          status: 'blocked',
          check: error.code ?? 'validation_failed',
          checkedAt: new Date().toISOString(),
        }) + '\n',
        { flag: 'wx' },
      );
    } catch {
      /* A fuller request-bound diagnosis already exists; do not overwrite it. */
    }
    console.error(
      `::error title=Automatic release stopped::${error.code ?? 'validation_failed'}; see automatic-release evidence. No replacement target or unsafe retry was selected.`,
    );
    process.exitCode = 1;
  }
}
