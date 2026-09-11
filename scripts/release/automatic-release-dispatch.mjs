import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertRun, requireAutomatic } from './automatic-release-contract.mjs';

export async function assertParentLive(client, request, attempt) {
  const run = await client.api(`actions/runs/${request.parentRunId}`);
  assertRun(run, client.repository, 'promote-release.yml', request.engineSha);
  requireAutomatic(
    run.status === 'in_progress' && run.run_attempt === attempt,
    'parent_not_active',
    '原请求已取消、结束或重跑，不再启动新的发布阶段。',
  );
  return run;
}

export function assertChildRun(run, step, repository) {
  assertRun(run, repository, step.workflow, step.engineSha);
  assert.equal(run.display_title, step.key);
  assert.equal(run.run_attempt, 1, 'Automatic child must not be manually rerun');
  return run;
}

/** Recover a lost HTTP acknowledgement by correlation, never by posting the dispatch twice. */
export async function runChild({
  client,
  ledger,
  requestRecord,
  parentAttempt,
  stage,
  workflow,
  sourceSha,
  inputs,
  deadline,
  now = Date.now,
  pause = sleep,
  signal,
}) {
  const request = requestRecord.payload;
  await assertParentLive(client, request, parentAttempt);
  const { record, fresh } = await ledger.step(
    requestRecord,
    parentAttempt,
    stage,
    workflow,
    sourceSha,
    inputs,
  );
  const step = record.payload;
  let runId;
  const discover = async () => {
    const runs = await client.pages(
      `actions/workflows/${workflow}/runs?event=workflow_dispatch&branch=main&created=${encodeURIComponent(`>=${request.requestedAt}`)}`,
      'workflow_runs',
    );
    const matches = runs.filter((run) => run.display_title === step.key);
    requireAutomatic(matches.length <= 1, 'duplicate_child', '发现重复的子运行，停止继续调度。');
    if (matches.length) runId = assertChildRun(matches[0], step, client.repository).id;
  };
  await discover();
  if (fresh && !runId) {
    // Persisted reservation above is intentionally BEFORE dispatch. Even a crash here does not
    // authorize another POST; a rerun reports an unknown dispatch instead of creating duplicates.
    await assertParentLive(client, request, parentAttempt);
    const main = await client.api('git/ref/heads/main');
    requireAutomatic(
      main.object?.sha === step.engineSha,
      'engine_changed',
      '主线发布引擎在本次请求后已变化；目标没有改变，已在写入前停止。',
    );
    try {
      const receipt = await client.api(`actions/workflows/${workflow}/dispatches`, {
        ref: 'main',
        return_run_details: true,
        inputs: { ...inputs, automation_id: String(record.id), automation_key: step.key },
      });
      if (Number.isSafeInteger(receipt?.workflow_run_id) && receipt.workflow_run_id > 0)
        runId = receipt.workflow_run_id;
    } catch (error) {
      if (error.code !== 'write_acknowledgement_unknown') throw error;
    }
  }
  const discoveryDeadline = Math.min(deadline, now() + 120000);
  while (!runId && now() < discoveryDeadline) {
    signal?.throwIfAborted();
    await pause(5000, undefined, { signal });
    await discover();
  }
  requireAutomatic(
    runId,
    'dispatch_unknown',
    '子运行派发回执不明确，已保留登记并停止；不会再次发起相同操作。',
  );
  console.log(
    `自动发布阶段 ${stage}：https://github.com/${client.repository}/actions/runs/${runId}`,
  );
  while (now() < deadline) {
    signal?.throwIfAborted();
    const run = assertChildRun(await client.api(`actions/runs/${runId}`), step, client.repository);
    if (run.status === 'completed') {
      requireAutomatic(
        run.conclusion === 'success',
        'child_failed',
        `自动发布阶段 ${stage} 未成功（run ${runId}）。不继续下一阶段，不把恢复旧版当成最终成功。`,
      );
      return { run, reservation: record };
    }
    await pause(15000, undefined, { signal });
  }
  throw Object.assign(
    new Error(`等待阶段 ${stage} 超时；子运行 ${runId} 可能仍在安全收尾，未重复派发或强制取消。`),
    { code: 'child_timeout' },
  );
}
