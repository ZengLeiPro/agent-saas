import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  assertPromotionConfigIdentityWriteGate,
  planPromotionConfigIdentityBaseline,
} from './promotion-config-identity-state.mjs';
import { selectLiveConfigIdentity } from './read-live-production-components.mjs';
import { validateExpectedConfigIdentityObservers } from './read-production-state.mjs';

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/legacy-api-promotion-retries.json', import.meta.url), 'utf8'),
);

test('正常发布与未写入重试固定走 steady-state', () => {
  for (const retryMode of ['fresh', 'retry_before_change']) {
    for (const action of ['deploy', 'keep']) {
      assert.deepEqual(
        planPromotionConfigIdentityBaseline({
          retryMode,
          apiAction: action,
          runtimeWorkerAction: action,
        }),
        { reader: 'read-production-state.mjs', configIdentityStage: 'steady-state' },
      );
    }
  }
});

test('生产写入拒绝缺失或不一致的身份，即使本轮将部署 API', () => {
  for (const manifest of [fixture.manifest, fixture.apiKeepManifest]) {
    for (const configIdentity of [undefined, { status: 'not_collected' }, { status: 'mismatch' }]) {
      assert.throws(
        () =>
          assertPromotionConfigIdentityWriteGate({
            manifest,
            productionState: { configIdentity },
          }),
        /require a consistent ConfigIdentity/u,
      );
    }
  }
  const state = fixture.retries.find(({ failedStage }) => failedStage === 'web').productionState;
  assert.deepEqual(
    assertPromotionConfigIdentityWriteGate({
      manifest: fixture.manifest,
      productionState: state,
    }),
    { configIdentityConfirmed: true },
  );
  assert.deepEqual(
    planPromotionConfigIdentityBaseline({
      retryMode: 'retry_after_change',
      apiAction: 'deploy',
      runtimeWorkerAction: 'deploy',
    }),
    { reader: 'read-live-production-components.mjs', configIdentityStage: 'candidate-readback' },
  );
});

test('App switched before Web failure is recoverable only in retry baseline', () => {
  const { productionState } = fixture.retries.find(({ failedStage }) => failedStage === 'web');
  const selected = selectLiveConfigIdentity({
    privateConfigIdentity: productionState.configIdentity,
    publicConfigIdentity: undefined,
    apiReleaseId: productionState.apiReleaseId,
    configIdentityStage: 'candidate-readback',
  });

  assert.throws(
    () =>
      validateExpectedConfigIdentityObservers(undefined, selected, {
        configIdentityStage: 'candidate-readback',
      }),
    /missing from trusted runtime identity/u,
  );
  assert.throws(
    () => validateExpectedConfigIdentityObservers(undefined, selected),
    /missing from trusted runtime identity during steady-state/u,
  );
  assert.doesNotThrow(() =>
    validateExpectedConfigIdentityObservers(
      fixture.observerBaselines.regularReleaseTrustedConfigIdentity,
      selected,
      { configIdentityStage: 'candidate-readback' },
    ),
  );
  assert.throws(
    () =>
      validateExpectedConfigIdentityObservers(
        fixture.observerBaselines.regularReleaseTrustedConfigIdentity,
        selected,
      ),
    /digest disagrees across observers/u,
  );
});

test('缺失身份且 API keep 时在写入前拒绝', () => {
  const legacyState = fixture.retries.find(
    ({ failedStage }) => failedStage === 'acs',
  ).productionState;
  assert.throws(
    () =>
      assertPromotionConfigIdentityWriteGate({
        manifest: fixture.apiKeepManifest,
        productionState: legacyState,
      }),
    /require a consistent ConfigIdentity/u,
  );
  assert.deepEqual(
    planPromotionConfigIdentityBaseline({
      retryMode: 'retry_after_change',
      apiAction: 'keep',
      runtimeWorkerAction: 'keep',
    }),
    {
      reader: 'read-live-production-components.mjs',
      configIdentityStage: 'steady-state',
    },
  );
});

test('API 和 Worker 动作不一致时拒绝重试', () => {
  assert.throws(
    () =>
      planPromotionConfigIdentityBaseline({
        retryMode: 'retry_after_change',
        apiAction: 'deploy',
        runtimeWorkerAction: 'keep',
      }),
    /actions must match/u,
  );
});
