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

test('first ConfigIdentity migration retries through planner, live selection, and observers', () => {
  const target = Object.fromEntries(
    Object.entries(fixture.manifest.components).map(([component, identity]) => {
      const { action: _action, sourceSha, ...digests } = identity;
      return [component, { gitSha: sourceSha, ...digests }];
    }),
  );
  for (const { failedStage, productionState, requiresApiUpgrade } of fixture.retries) {
    const plan = planPromotionConfigIdentityBaseline({
      retryMode: 'retry_after_change',
      apiAction: fixture.manifest.components.api.action,
      runtimeWorkerAction: fixture.manifest.components.runtimeWorker.action,
    });
    assert.deepEqual(plan, {
      reader: 'read-live-production-components.mjs',
      configIdentityStage: 'legacy-api-upgrade-retry-baseline',
    });
    const selected = selectLiveConfigIdentity({
      privateConfigIdentity: productionState.configIdentity,
      publicConfigIdentity: undefined,
      apiReleaseId: productionState.apiReleaseId,
      configIdentityStage: plan.configIdentityStage,
    });
    assert.doesNotThrow(
      () =>
        validateExpectedConfigIdentityObservers(
          fixture.observerBaselines.firstMigrationTrustedConfigIdentity,
          selected,
          { configIdentityStage: plan.configIdentityStage },
        ),
      failedStage,
    );

    for (const [component, observed] of Object.entries(productionState.components)) {
      const baselineJson = JSON.stringify(fixture.manifest.productionBaseline[component]);
      const targetJson = JSON.stringify(target[component]);
      assert.ok(
        [baselineJson, targetJson].includes(JSON.stringify(observed)),
        `${failedStage} ${component} must be baseline or target`,
      );
    }
    assert.equal(
      assertPromotionConfigIdentityWriteGate({
        manifest: fixture.manifest,
        productionState,
      }).legacyApiRequiresUpgrade,
      requiresApiUpgrade,
      failedStage,
    );
  }
});

test('App switched before Web failure is recoverable only in retry baseline', () => {
  const { productionState } = fixture.retries.find(({ failedStage }) => failedStage === 'web');
  const selected = selectLiveConfigIdentity({
    privateConfigIdentity: productionState.configIdentity,
    publicConfigIdentity: undefined,
    apiReleaseId: productionState.apiReleaseId,
    configIdentityStage: 'legacy-api-upgrade-retry-baseline',
  });

  assert.doesNotThrow(() =>
    validateExpectedConfigIdentityObservers(undefined, selected, {
      configIdentityStage: 'legacy-api-upgrade-retry-baseline',
    }),
  );
  assert.throws(
    () => validateExpectedConfigIdentityObservers(undefined, selected),
    /missing from trusted runtime identity during steady-state/u,
  );
  assert.doesNotThrow(() =>
    validateExpectedConfigIdentityObservers(
      fixture.observerBaselines.regularReleaseTrustedConfigIdentity,
      selected,
      { configIdentityStage: 'legacy-api-upgrade-retry-baseline' },
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

test('legacy API plus API keep is rejected before any production write', () => {
  const legacyState = fixture.retries.find(
    ({ failedStage }) => failedStage === 'acs',
  ).productionState;
  assert.throws(
    () =>
      assertPromotionConfigIdentityWriteGate({
        manifest: fixture.apiKeepManifest,
        productionState: legacyState,
      }),
    /requires this Manifest to deploy API and Runtime Worker before any production write/u,
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

test('the legacy retry stage cannot be selected when API and Worker actions disagree', () => {
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
