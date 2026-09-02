import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { validateMobileSubmitCredentials } from './mobile-submit-credential-policy.mjs';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);

test('M60-04 submit credential policy isolates all three profiles', () => {
  const cases = [
    {
      profile: 'ios-store',
      valid: {
        APP_STORE_CONNECT_API_KEY_P8: 'private-key',
        APP_STORE_CONNECT_API_KEY_ID: 'key-id',
        APP_STORE_CONNECT_ISSUER_ID: 'issuer-id',
      },
      missing: 'APP_STORE_CONNECT_API_KEY_P8',
    },
    {
      profile: 'android-store',
      valid: { ANDROID_PLAY_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}' },
      missing: 'ANDROID_PLAY_SERVICE_ACCOUNT_JSON',
    },
    {
      profile: 'android-enterprise',
      valid: {
        ENTERPRISE_MDM_ROBOT_TOKEN: 'robot-token',
        MOBILE_ENTERPRISE_SUBMIT_ENDPOINT: 'https://mdm.example.com/mobile/upload',
      },
      missing: 'ENTERPRISE_MDM_ROBOT_TOKEN',
    },
  ];
  for (const { profile, valid, missing } of cases) {
    assert.doesNotThrow(() => validateMobileSubmitCredentials(profile, valid));
    assert.throws(() => validateMobileSubmitCredentials(profile, {}), new RegExp(missing));
  }
  assert.doesNotThrow(() =>
    validateMobileSubmitCredentials('android-enterprise', {
      ENTERPRISE_MDM_ROBOT_TOKEN: 'robot-token',
      MOBILE_ENTERPRISE_SUBMIT_ENDPOINT: 'https://mdm.example.com/mobile/upload',
      ANDROID_PLAY_SERVICE_ACCOUNT_JSON: '',
    }),
  );
  assert.throws(
    () =>
      validateMobileSubmitCredentials('android-enterprise', {
        ENTERPRISE_MDM_ROBOT_TOKEN: 'robot-token',
        MOBILE_ENTERPRISE_SUBMIT_ENDPOINT: 'http://user:password@mdm.example.com/upload',
      }),
    /credential-free HTTPS/u,
  );
});

test('M60-04 downloaded artifact verifier invokes platform signing and identity tools', () => {
  const verifier = readFileSync(
    resolve(root, 'mobile/scripts/verify-mobile-release-artifact.sh'),
    'utf8',
  );
  for (const command of [
    'codesign',
    'security cms',
    'plutil',
    'apksigner',
    'bundletool',
    'aapt',
    'jarsigner',
    'REQUEST_INSTALL_PACKAGES',
  ])
    assert.match(verifier, new RegExp(command));
  assert.match(verifier, /debug signer rejected/u);
});

test('M60-04 eas.json passes the schema bundled with the exact EAS CLI', async () => {
  const { EasJsonAccessor } = require('@expo/eas-json');
  const eas = await EasJsonAccessor.fromProjectPath(resolve(root, 'mobile')).readAsync();
  assert.deepEqual(Object.keys(eas.build), [
    'development',
    'preview',
    'production',
    'production-store',
    'production-enterprise',
  ]);
});

test('M60-04 EAS profiles pin exact CLI and immutable cloud images', () => {
  const eas = JSON.parse(readFileSync(resolve(root, 'mobile/eas.json'), 'utf8'));
  assert.equal(eas.cli.version, '18.1.0');
  assert.equal(eas.build.production.ios.image, 'macos-sequoia-15.6-xcode-16.4');
  assert.equal(eas.build['production-store'].android.image, 'ubuntu-24.04-jdk-17-ndk-r27b-sdk-55');
  assert.equal(
    eas.build['production-enterprise'].android.image,
    'ubuntu-24.04-jdk-17-ndk-r27b-sdk-55',
  );
  assert.equal(eas.build['production-store'].android.buildType, 'app-bundle');
  assert.equal(eas.build['production-enterprise'].android.buildType, 'apk');
});
