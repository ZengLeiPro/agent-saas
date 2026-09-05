import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { canonicalJson, digestBuffer } from './artifact-lib.mjs';

const linux = process.platform === 'linux';
const releaseId = 'rc-20260906-01';
const digest = 'sha256:' + 'a'.repeat(64);
const sourceSha = 'b'.repeat(40);
const manifest = {
  releaseId,
  releaseSha: sourceSha,
  digest,
  migrationPlan: {
    phase: 'expand',
    confirmation: 'required_after_observation',
    planDigest: digest,
  },
  components: Object.fromEntries(
    ['web', 'api', 'runtimeWorker', 'acs'].map((name) => [
      name,
      name === 'acs'
        ? { sourceSha, orchestratorArtifactDigest: digest, sandboxImageDigest: digest }
        : { sourceSha, artifactDigest: digest },
    ]),
  ),
};
const components = Object.fromEntries(
  Object.entries(manifest.components).map(([name, { sourceSha, ...rest }]) => [
    name,
    { gitSha: sourceSha, ...rest },
  ]),
);

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'finalize-expand-'));
  for (const dir of ['bin', 'attestations']) mkdirSync(join(root, dir));
  const fixture = {
    live: {
      schemaVersion: 1,
      environment: 'production',
      observedAt: new Date().toISOString(),
      components,
    },
    apiReady: {
      status: 'ok',
      release: {
        environment: 'production',
        safetyAttested: true,
        releaseId,
        releaseSha: sourceSha,
      },
    },
  };
  const binding = {
    releaseId,
    releaseSha: sourceSha,
    manifestDigest: digest,
    migrationPhase: 'expand',
    migrationPlanDigest: digest,
    productionBeforeDigest: digest,
    productionTargetDigest: digestBuffer(canonicalJson(components)),
  };
  const recordedAt = new Date(Date.now() - 1000).toISOString();
  const history = [
    'built',
    'staging_deployed',
    'verified',
    'approved',
    'promoting',
    'awaiting_expand_confirmation',
  ].map((state, index) => ({
    id: String(index + 1),
    state,
    releaseId,
    manifestDigest: digest,
    operationKey: state,
    actor: 'test',
    recordedAt,
    ...(state === 'promoting' ? { reason: JSON.stringify(binding) } : {}),
  }));
  writeFileSync(join(root, 'fixture.json'), JSON.stringify(fixture));
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(
    join(root, 'attestations', releaseId + '.jsonl'),
    history.map(JSON.stringify).join('\n') + '\n',
  );
  writeFileSync(join(root, 'events'), '');
  for (const command of ['ssh', 'scp', 'curl', 'bash', 'pnpm']) {
    const target = join(root, 'bin', command);
    copyFileSync(new URL('./fixtures/finalization-io.mjs', import.meta.url), target);
    chmodSync(target, 0o755);
  }
  const pnpm = spawnSync('/bin/bash', ['-c', 'command -v pnpm'], {
    encoding: 'utf8',
  }).stdout.trim();
  const env = {
    ...process.env,
    PATH: join(root, 'bin') + ':' + process.env.PATH,
    FINALIZATION_TEST_ROOT: root,
    FINALIZATION_REAL_PNPM: pnpm,
    RUNNER_TEMP: root,
    RELEASE_ID: releaseId,
    MANIFEST_DIGEST: digest,
    GITHUB_RUN_ID: '123',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_ACTOR: 'release-test',
    GITHUB_STEP_SUMMARY: join(root, 'summary'),
    ECS_USER: 'test',
    ECS_HOST: 'host',
    RELEASE_RECORD_OSS_URI: 'oss://test-release',
    CONFIRMATION_REASON: '自动收尾测试',
  };
  return { root, env };
}

function run(env) {
  return spawnSync('/bin/bash', ['scripts/release/finalize-expand-migration.sh'], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}
function state(root) {
  return JSON.parse(
    readFileSync(join(root, 'attestations', releaseId + '.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .at(-1),
  ).state;
}
function events(root) {
  return readFileSync(join(root, 'events'), 'utf8').trim().split('\n');
}

test(
  'Linux 实际自动收尾：两次回读、证据上传、真实状态机 completed、GitHub 与 OSS 落盘',
  { skip: !linux },
  () => {
    const { root, env } = setup();
    const result = run(env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(state(root), 'completed');
    assert.deepEqual(events(root), [
      'read-initial',
      'read-final',
      'evidence-upload',
      'append-completed',
      'github-upload',
      'oss-mirror',
    ]);
    assert.equal(
      readFileSync(join(root, 'github.jsonl'), 'utf8'),
      readFileSync(join(root, 'oss-mirror.json'), 'utf8'),
    );
  },
);

for (const scenario of ['drift', 'ready-fail', 'evidence-upload', 'lock-loss']) {
  test('Linux 自动收尾失败不提交 completed：' + scenario, { skip: !linux }, () => {
    const { root, env } = setup();
    const result = run({ ...env, FINALIZATION_TEST_SCENARIO: scenario });
    assert.notEqual(result.status, 0, scenario);
    assert.equal(state(root), 'awaiting_expand_confirmation');
    assert.ok(!events(root).includes('append-completed'));
    assert.ok(!existsSync(join(root, 'github.jsonl')));
  });
}

test('Linux GitHub 上传失败后，新 runner 从耐久等待状态续做确认', { skip: !linux }, () => {
  const first = setup();
  const failed = run({ ...first.env, FINALIZATION_TEST_SCENARIO: 'github-upload' });
  assert.notEqual(failed.status, 0);
  assert.equal(state(first.root), 'completed');
  assert.ok(!existsSync(join(first.root, 'github.jsonl')));
  assert.ok(!events(first.root).includes('oss-mirror'));
  // 新 runner 只会从 GitHub 取回旧 awaiting 凭证，不复用失败 runner 的本地 completed。
  const retry = setup();
  const completed = run({ ...retry.env, GITHUB_RUN_ATTEMPT: '2' });
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(state(retry.root), 'completed');
});

test(
  'Linux GitHub 完成而 OSS 失败，同一 run 重跑只修镜像、不读取或部署生产',
  { skip: !linux },
  () => {
    const { root, env } = setup();
    const first = run({ ...env, FINALIZATION_TEST_SCENARIO: 'oss-mirror' });
    assert.notEqual(first.status, 0);
    assert.equal(state(root), 'completed');
    const initial = events(root);
    const repaired = run({ ...env, GITHUB_RUN_ATTEMPT: '2' });
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.deepEqual(events(root).slice(initial.length), ['oss-mirror']);
    assert.equal(
      readFileSync(join(root, 'github.jsonl'), 'utf8'),
      readFileSync(join(root, 'oss-mirror.json'), 'utf8'),
    );
  },
);
