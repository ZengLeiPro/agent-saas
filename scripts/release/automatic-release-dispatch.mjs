import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertRun, requireAutomatic } from './automatic-release-contract.mjs';

const parentObservation = (run, client, request, attempt) => {
  assertRun(run, client.repository, 'promote-release.yml', request.engineSha);
  requireAutomatic(
    Number(run.run_attempt) === Number(attempt),
    'parent_attempt_changed',
    '原请求已换代，旧子任务不得继续产生变更。',
  );
  return run.status === 'in_progress' && run.conclusion === null;
};

/** GitHub 状态短暂滞后时只作有界复核；连续两次精确 attempt 存活才允许继续。 */
export async function assertParentLive(
  client,
  request,
  attempt,
  { pause = sleep, signal } = {},
) {
  let consecutiveLive = 0;
  let last;
  for (let observation = 0; observation < 3; observation += 1) {
    signal?.throwIfAborted();
    const run = await client.api(`actions/runs/${request.parentRunId}`);
    last = run;
    if (parentObservation(run, client, request, attempt)) {
      consecutiveLive += 1;
      if (consecutiveLive === 2) return run;
    } else {
      consecutiveLive = 0;
    }
    if (observation < 2) await pause(1000, undefined, { signal });
  }
  requireAutomatic(
    false,
    'parent_not_live',
    `原请求已停止或状态未稳定（最后状态：${last?.status ?? 'unknown'}），子任务不得开始新的变更。`,
  );
}

export function assertChildRun(run, step, repository, { allowQueuedMetadata = false } = {}) {
  assertRun(run, repository, step.workflow, step.engineSha);
  assert.equal(run.run_attempt, 1, 'Automatic child must not be manually rerun');
  if (run.display_title !== step.key) {
    requireAutomatic(
      allowQueuedMetadata && run.status === 'queued' && run.conclusion === null,
      'child_identity_mismatch',
      '子运行的不可变关联键与登记不一致。',
    );
    return null;
  }
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
  const evidence = {
    schemaVersion: 1,
    stage,
    parentRunId: request.parentRunId,
    parentRunAttempt: parentAttempt,
    workflow,
    sourceSha,
    childRunId: null,
  };
  try {
    await assertParentLive(client, request, parentAttempt, { pause, signal });
    const { record, fresh } = await ledger.step(
      requestRecord,
      parentAttempt,
      stage,
      workflow,
      sourceSha,
      inputs,
    );
    const step = record.payload;
    evidence.reservationId = String(record.id);
    evidence.automationKey = step.key;
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
      // 登记必须先于 dispatch；中断后只报告未知结果，不再第二次 POST。
      await assertParentLive(client, request, parentAttempt, { pause, signal });
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
    evidence.childRunId = String(runId);
    console.log(
      `自动发布阶段 ${stage}：https://github.com/${client.repository}/actions/runs/${runId}`,
    );
    while (now() < deadline) {
      signal?.throwIfAborted();
      const run = assertChildRun(await client.api(`actions/runs/${runId}`), step, client.repository, {
        allowQueuedMetadata: true,
      });
      // dispatch 回执已锁定子 run；排队期间标题表达式可能尚未可读，且此时没有生产凭据。
      if (!run) {
        await pause(5000, undefined, { signal });
        continue;
      }
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
  } catch (error) {
    error.automaticRelease = { ...evidence, rejection: error.code ?? 'validation_failed' };
    throw error;
  }
}
