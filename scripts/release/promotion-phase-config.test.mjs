import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promotionPhaseConfigIdentityStage } from './verify-promotion-phase-state.mjs';

const phaseVerifier = new URL('./verify-promotion-phase-state.mjs', import.meta.url).pathname;
const liveReader = new URL('./read-live-production-components.mjs', import.meta.url).href;
const script = readFileSync(new URL('./deploy-production-release.sh', import.meta.url), 'utf8');
const start = script.indexOf('production_now="/tmp/agent-saas-production-before-');
const end = script.indexOf('if [ "$VERIFY_ONLY" = true ]; then', start);
assert.ok(start > 0 && end > start);
const commands = script.slice(start, end);
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/legacy-api-promotion-retries.json', import.meta.url)),
);

function runPhase(
  phase,
  {
    keepApi = false,
    drift = false,
    privateSnapshot = false,
    inconsistent = false,
    wrongRelease = false,
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'promotion-phase-config-'));
  const manifest = structuredClone(fixture.manifest);
  manifest.productionBaseline = Object.fromEntries(
    Object.entries(manifest.productionBaseline).map(([component, { gitSha, ...identity }]) => [
      component,
      { sourceSha: gitSha, ...identity },
    ]),
  );
  if (keepApi) {
    manifest.components.api.action = 'keep';
    manifest.components.runtimeWorker.action = 'keep';
  }
  const { productionState } = fixture.retries.find(({ failedStage }) => failedStage === phase);
  const state = structuredClone(productionState);
  if (!state.configIdentity && privateSnapshot) {
    state.configIdentity = structuredClone(
      fixture.retries.find(({ failedStage }) => failedStage === 'web').productionState
        .configIdentity,
    );
    state.configIdentity.releaseId = state.apiReleaseId;
  }
  if (drift) state.components.web.artifactDigest = `sha256:${'f'.repeat(64)}`;
  const snapshot = privateSnapshot ? structuredClone(state.configIdentity) : undefined;
  if (snapshot && inconsistent) snapshot.status = 'mismatch';
  if (snapshot && wrongRelease) snapshot.releaseId = 'other-release';
  const manifestPath = join(root, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const readerPath = join(root, 'reader.mjs');
  // 仅替换环境取数，配置快照选择和阶段矩阵检查均执行真实实现。
  writeFileSync(
    readerPath,
    `
import { writeFileSync } from 'node:fs';
import { selectLiveConfigIdentity } from ${JSON.stringify(liveReader)};
import { validateExpectedConfigIdentityObservers } from ${JSON.stringify(new URL('./read-production-state.mjs', import.meta.url).href)};
const state = ${JSON.stringify(state)};
const args = process.argv.slice(2);
const index = args.indexOf('--config-identity-stage');
const stage = index < 0 ? 'steady-state' : args[index + 1];
const configIdentity = selectLiveConfigIdentity({
  privateConfigIdentity: ${JSON.stringify(snapshot)},
  publicConfigIdentity: undefined,
  apiReleaseId: state.apiReleaseId,
  configIdentityStage: stage,
});
validateExpectedConfigIdentityObservers(${JSON.stringify(fixture.observerBaselines.regularReleaseTrustedConfigIdentity)}, configIdentity, { configIdentityStage: stage });
writeFileSync(args[args.indexOf('--output') + 1], JSON.stringify(state));
`,
  );
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail\n${commands.replace('/tmp/agent-saas-production-before-', `${root}/production-before-`)}`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PHASE: phase,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '1',
        MANIFEST_PATH: manifestPath,
        READ_LIVE_COMPONENTS_SCRIPT: readerPath,
        VERIFY_PROMOTION_PHASE_SCRIPT: phaseVerifier,
      },
    },
  );
}

for (const phase of ['acs', 'app']) {
  test(`${phase} 实际 shell 前置检查要求私有身份，并继续核对完整生产矩阵`, () => {
    const result = runPhase(phase, { privateSnapshot: true });
    assert.equal(result.status, 0, result.stderr);
    const drift = runPhase(phase, { drift: true, privateSnapshot: true });
    assert.notEqual(drift.status, 0);
    assert.match(drift.stderr, /Production changed after promotion gate/);
  });
}

test('Web 阶段和 API 保持原样的发布仍拒绝缺失私有快照', () => {
  for (const [phase, options] of [
    ['web', {}],
    ['acs', {}],
    ['app', {}],
    ['acs', { keepApi: true }],
  ]) {
    const result = runPhase(phase, options);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Private Production ConfigIdentity snapshot is required during (steady-state|candidate-readback)/,
    );
  }
});

test('阶段或 API/Worker 动作非法时不能选择兼容模式', () => {
  assert.throws(
    () => promotionPhaseConfigIdentityStage(fixture.manifest, 'unknown'),
    /Unknown promotion phase/,
  );
  const manifest = structuredClone(fixture.manifest);
  manifest.components.runtimeWorker.action = 'keep';
  assert.throws(() => promotionPhaseConfigIdentityStage(manifest, 'acs'), /actions must match/);
});

test('Web 允许已升级的私有身份先于 trusted 提交，并继续拒绝错误身份和组件漂移', () => {
  const valid = runPhase('web', { privateSnapshot: true });
  assert.equal(valid.status, 0, valid.stderr);
  for (const option of ['inconsistent', 'wrongRelease', 'drift']) {
    const result = runPhase('web', { privateSnapshot: true, [option]: true });
    assert.notEqual(result.status, 0, option);
  }
  const keep = runPhase('web', { privateSnapshot: true, keepApi: true });
  assert.notEqual(keep.status, 0);
  assert.match(keep.stderr, /digest disagrees across observers/);
});
