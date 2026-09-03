import assert from 'node:assert/strict';
import test from 'node:test';
import configModule from './incoming-share-config.cjs';

const { applyIncomingShareConfig, incomingSharePluginOptions } = configModule;

test('registers exact ACTION_SEND/SEND_MULTIPLE MIME envelope', () => {
  const result = incomingSharePluginOptions({});
  assert.equal(result.plugin[0], 'expo-share-intent');
  assert.deepEqual(result.plugin[1].androidIntentFilters, ['text/plain', 'image/*', 'application/pdf']);
  assert.deepEqual(result.plugin[1].androidMultiIntentFilters, ['image/*', 'application/pdf']);
  assert.equal(result.plugin[1].disableIOS, true);
});

test('production iOS prebuild fails closed without identity and accepts the release-manifest identity', () => {
  assert.throws(
    () => incomingSharePluginOptions({ EAS_BUILD_PROFILE: 'production' }),
    /requires MOBILE_IOS_APPLE_TEAM_ID and MOBILE_IOS_SHARE_APP_GROUP/,
  );
  const configured = applyIncomingShareConfig({ plugins: [], ios: {} }, {
    EAS_BUILD_PROFILE: 'production',
    MOBILE_IOS_APPLE_TEAM_ID: 'A1B2C3D4E5',
    MOBILE_IOS_SHARE_APP_GROUP: 'group.com.example.agent.share',
  });
  assert.equal(configured.ios.appleTeamId, 'A1B2C3D4E5');
  assert.deepEqual(configured.ios.entitlements['keychain-access-groups'], [
    '$(AppIdentifierPrefix)group.com.example.agent.share',
  ]);
  assert.equal(configured.plugins[0][1].iosAppGroupIdentifier, 'group.com.example.agent.share');
  assert.equal(configured.plugins[0][1].iosActivationRules.NSExtensionActivationSupportsImageWithMaxCount, 5);

  const manifestConfigured = applyIncomingShareConfig(
    { plugins: [], ios: {} },
    { EAS_BUILD_PROFILE: 'production' },
    {
      iosAppleTeamId: 'T4D4M5B485',
      iosAppGroupIdentifier: 'group.com.agentsaas.mobile.share',
    },
  );
  assert.equal(manifestConfigured.ios.appleTeamId, 'T4D4M5B485');
  assert.deepEqual(manifestConfigured.ios.entitlements['keychain-access-groups'], [
    '$(AppIdentifierPrefix)group.com.agentsaas.mobile.share',
  ]);
  assert.equal(
    manifestConfigured.plugins[0][1].iosAppGroupIdentifier,
    'group.com.agentsaas.mobile.share',
  );
});
