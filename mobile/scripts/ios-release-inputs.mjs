import assert from 'node:assert/strict';
import {
  IOS_BUILD_JOB, IOS_WORKFLOW, requireId, requireSha,
  validateBuildRun, validateCiRun, validateDispatch,
} from './ios-actions-policy.mjs';

export const RELEASE_OPERATIONS = Object.freeze({
  '构建并发布到 TestFlight': 'build-and-testflight',
  '仅构建，不发布': 'build',
  '重试已有构建的发布': 'testflight',
});
export const DEFAULT_RELEASE_OPERATION = '构建并发布到 TestFlight';
export const CI_WAIT_TIMEOUT_MS = 20 * 60_000;
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

export function parseBuildRunReference(value, repository) {
  assert.equal(typeof value, 'string', '请填写原构建的 Actions 运行链接或编号');
  const text = value.trim();
  if (/^[1-9][0-9]*$/u.test(text)) return requireId(text, '原构建运行编号');
  // Parse, but never fetch, user-supplied URLs. All metadata requests below are
  // relative to the authenticated repository's fixed GitHub API base.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/actions\/runs\/([1-9][0-9]*)(?:\/job\/[1-9][0-9]*)?\/?(?:\?[^#\s]*)?(?:#[^\s]*)?$/u.exec(text);
  assert.ok(match, '请使用本仓库的 Actions 运行链接或纯数字编号');
  assert.equal(match[1].toLowerCase(), repository.toLowerCase(), '原构建链接必须属于当前仓库');
  return requireId(match[2], '原构建运行编号');
}

function assertReleaseRun(run, repository, buildRunId) {
  assert.equal(String(run.id), buildRunId, '原构建运行编号不匹配');
  assert.equal(run.repository?.full_name, repository, '原构建不属于当前仓库');
  assert.equal(run.head_repository?.full_name, repository, '不能使用 fork 的构建');
  assert.equal(run.path, IOS_WORKFLOW, '只能复用 iOS 构建与发布工作流的制品');
  assert.equal(run.event, 'workflow_dispatch', '不能发布 PR 检查产生的制品');
  assert.equal(run.head_branch, 'main', '原构建必须从 main 触发');
  assert.equal(run.status, 'completed', '原运行尚未完成，请在结束后重试发布');
  requireSha(run.head_sha, '原构建 workflow SHA');
  requireId(run.run_attempt, '原构建 attempt');
}

// Recover the source and the *producing* attempt from immutable artifact names
// and that exact attempt's successful build job, not from the latest attempt.
// The downloaded ios-release.json is independently checked by verifyBundle
// before signing verification/upload. Do not trust the name as final evidence.
export async function resolveRetryBuild(context, buildRunId, { api, pages }) {
  const run = await api(`/actions/runs/${buildRunId}`);
  assertReleaseRun(run, context.repository, buildRunId);
  const artifacts = await pages(`/actions/runs/${buildRunId}/artifacts`, 'artifacts');
  const candidates = [];
  const attempts = new Map();
  for (const artifact of artifacts) {
    if (!artifact.name?.startsWith('ios-ipa-')) continue;
    const match = /^ios-ipa-([0-9a-f]{40})-([1-9][0-9]*)-([1-9][0-9]*)$/u.exec(artifact.name);
    assert.ok(match, '原运行存在格式无效的 IPA 制品，拒绝猜测');
    const [, sourceSha, artifactRunId, attempt] = match;
    assert.equal(requireId(artifactRunId, 'artifact run ID'), buildRunId, 'IPA 制品运行编号不匹配');
    assert.ok(Number(requireId(attempt, 'artifact attempt')) <= Number(run.run_attempt), 'IPA 制品 attempt 不存在');
    assert.equal(typeof artifact.expired, 'boolean', 'IPA 制品过期状态缺失');
    if (artifact.expired) continue;
    if (!attempts.has(attempt)) {
      const original = await api(`/actions/runs/${buildRunId}/attempts/${attempt}`);
      assertReleaseRun(original, context.repository, buildRunId);
      assert.equal(String(original.run_attempt), attempt, 'GitHub 返回了错误的构建 attempt');
      assert.equal(original.head_sha, run.head_sha, '原构建 workflow SHA 发生变化');
      const jobs = await pages(`/actions/runs/${buildRunId}/attempts/${attempt}/jobs`, 'jobs');
      attempts.set(attempt, { original, jobs });
    }
    const { original, jobs } = attempts.get(attempt);
    const builds = jobs.filter((job) => job.name === IOS_BUILD_JOB);
    assert.ok(builds.length <= 1, '原 attempt 存在多个签名构建任务');
    const build = builds[0];
    if (!build || build.status !== 'completed' || build.conclusion !== 'success') continue;
    assert.equal(String(build.run_id), buildRunId, '签名构建任务不属于原运行');
    assert.equal(String(build.run_attempt), attempt, '不能把继承的构建任务当作本次 attempt 的构建');
    assert.equal(artifact.workflow_run?.head_sha, run.head_sha, 'IPA 制品 workflow SHA 不匹配');
    const expected = { repository: context.repository, sourceSha, buildRunId, buildAttempt: attempt, currentRunId: context.runId };
    const authorized = validateBuildRun(original, jobs, artifacts, expected);
    candidates.push({ sourceSha, buildRunId, buildAttempt: attempt, ...authorized });
  }
  assert.ok(candidates.length > 0, '原运行没有成功构建且未过期的已封存 IPA；不会自动重新构建');
  assert.equal(candidates.length, 1, '原运行存在多个可用 IPA，无法唯一确定；请新建一次构建发布，不会自动选择最新 attempt');
  // Fail closed if somebody started a rerun while the metadata was inspected.
  const refreshed = await api(`/actions/runs/${buildRunId}`);
  assertReleaseRun(refreshed, context.repository, buildRunId);
  assert.equal(refreshed.run_attempt, run.run_attempt, '原运行正在重跑，请结束后重新选择');
  assert.equal(refreshed.head_sha, run.head_sha, '原构建 workflow SHA 发生变化');
  return candidates[0];
}

export async function resolveReleaseInputs(context, inputs, dependencies) {
  // The old low-level dispatch validator remains the final authority for
  // normalized source/run/attempt values. Removed UI inputs are not overrides.
  assert.ok(inputs && typeof inputs === 'object' && !Array.isArray(inputs), '无效的发布参数');
  for (const key of Object.keys(inputs)) {
    assert.ok(['operation', 'build_run'].includes(key), `不再支持发布参数 ${key}`);
  }
  const label = inputs.operation ?? DEFAULT_RELEASE_OPERATION;
  assert.ok(Object.hasOwn(RELEASE_OPERATIONS, label), '未知的 iOS 执行操作');
  const operation = RELEASE_OPERATIONS[label];
  // Validate manual main context before any network request, including retry.
  validateDispatch(context, { operation: 'build' });
  assert.equal(typeof (inputs.build_run ?? ''), 'string', '原构建必须是链接或编号');
  const reference = (inputs.build_run ?? '').trim();
  if (operation !== 'testflight') {
    assert.equal(reference, '', '新构建不能填写原构建运行链接或编号；请清空或选择重试');
    return validateDispatch(context, { operation });
  }
  const buildRunId = parseBuildRunReference(reference, context.repository);
  assert.notEqual(buildRunId, String(context.runId), '重试必须引用之前的构建运行');
  const resolved = await resolveRetryBuild(context, buildRunId, dependencies);
  return {
    ...validateDispatch(context, { operation, source_sha: resolved.sourceSha, build_run_id: resolved.buildRunId, build_run_attempt: resolved.buildAttempt }),
    artifactId: resolved.artifactId,
    artifactDigest: resolved.artifactDigest,
    workflowSha: resolved.workflowSha,
  };
}

export function assertPinnedArtifact(actual, expected) {
  const values = [expected.artifactId, expected.artifactDigest, expected.workflowSha];
  if (values.every((value) => !value)) return; // new build: no artifact exists at plan time
  assert.ok(values.every(Boolean), '重试制品绑定信息不完整');
  assert.equal(actual.artifactId, expected.artifactId, 'IPA 制品 ID 与发布计划不一致');
  assert.equal(actual.artifactDigest, expected.artifactDigest, 'IPA 制品摘要与发布计划不一致');
  assert.equal(actual.workflowSha, expected.workflowSha, 'IPA workflow SHA 与发布计划不一致');
}

export async function waitForCi(sourceSha, repository, load, {
  timeoutMs = CI_WAIT_TIMEOUT_MS, intervalMs = 15_000, now = Date.now,
  pause = sleep, progress = () => {},
} = {}) {
  requireSha(sourceSha);
  assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 0 && timeoutMs <= CI_WAIT_TIMEOUT_MS);
  assert.ok(Number.isFinite(intervalMs) && intervalMs > 0);
  const deadline = now() + timeoutMs;
  let first = true;
  while (first || now() < deadline) {
    first = false;
    const snapshot = await load(sourceSha);
    if (snapshot) {
      const { run, jobs } = snapshot;
      // Even pending metadata must match the exact dispatch source; no fallback
      // to another commit, PR workflow or an older successful run is permitted.
      assert.equal(run.repository?.full_name, repository, 'CI 仓库不匹配');
      assert.equal(run.head_repository?.full_name, repository, '不能使用 fork 的 CI');
      assert.equal(run.path, '.github/workflows/ci.yml', 'CI workflow 不匹配');
      assert.equal(run.event, 'push', '必须使用 push-main CI');
      assert.equal(run.head_branch, 'main', 'CI 必须属于 main');
      assert.equal(run.head_sha, sourceSha, 'CI source mismatch');
      if (run.status === 'completed') return validateCiRun(run, jobs, sourceSha, repository);
      assert.ok(['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status), '未知 CI 状态');
    }
    if (now() >= deadline) break;
    progress(sourceSha, snapshot?.run);
    await pause(Math.min(intervalMs, deadline - now()));
  }
  throw new Error(`等待指定源码 ${sourceSha} 的 main CI 超时或 CI 尚未完成；不会改用旧提交，请在该 CI 成功后重新运行`);
}
