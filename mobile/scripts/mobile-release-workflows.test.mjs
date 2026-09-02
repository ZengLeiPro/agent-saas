import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { validateMobileSubmitCredentials } from './mobile-submit-credential-policy.mjs';
const root = resolve(import.meta.dirname, '../..');
const require = createRequire(import.meta.url);
const paths = [
  '.github/workflows/testflight.yml',
  '.github/workflows/mobile-submit.yml',
  '.github/workflows/mobile-rollout.yml',
];
const sources = Object.fromEntries(
  paths.map((path) => [path, readFileSync(resolve(root, path), 'utf8')]),
);
const parsed = Object.fromEntries(
  Object.entries(sources).map(([path, source]) => [path, YAML.parse(source)]),
);

test('M60-04 workflow YAML parses and exposes only reviewed manual/reusable triggers', () => {
  for (const [path, workflow] of Object.entries(parsed)) {
    assert.ok(workflow.on.workflow_dispatch, path);
    assert.ok(workflow.on.workflow_call, path);
    assert.equal(workflow.on.pull_request, undefined, path);
    assert.equal(workflow.on.push, undefined, path);
  }
});

test('M60-04 build pins complete toolchain, frozen lock and never submits', () => {
  const source = sources['.github/workflows/testflight.yml'];
  for (const required of [
    '22.23.1',
    '10.18.3',
    '18.1.0',
    '16.4',
    'macos-15',
    'ubuntu-24.04',
    'macos-sequoia-15.6-xcode-16.4',
    'ubuntu-24.04-jdk-17-ndk-r27b-sdk-55',
    'pnpm install --frozen-lockfile',
  ])
    assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(source, /--auto-submit|eas submit/u);
  assert.match(source, /environment: mobile-build-production/u);
  assert.match(source, /EXPO_ORG_ROBOT_TOKEN/u);
  assert.match(source, /MOBILE_RELEASE_MANIFEST_JSON/u);
  assert.match(source, /MOBILE_RELEASE_MANIFEST_HMAC_KEY/u);
  assert.match(source, /--manifest "\$manifest" --manifest-signature "\$signature"/u);
  assert.doesNotMatch(source, /EXPO_TOKEN:\s*\$\{\{\s*secrets\.EXPO_TOKEN/u);
});

test('M60-04 submit and rollout use separate approval environments and immutable receipts', () => {
  const submit = sources['.github/workflows/mobile-submit.yml'];
  const rollout = sources['.github/workflows/mobile-rollout.yml'];
  assert.match(submit, /environment: mobile-submit-\$\{\{ inputs\.profile \}\}/u);
  assert.match(submit, /validate-submit/u);
  assert.doesNotMatch(submit, /eas build/u);
  assert.match(rollout, /environment: mobile-rollout-\$\{\{ inputs\.profile \}\}/u);
  assert.match(rollout, /validate-submit/u);
  assert.match(rollout, /\[start, pause, resume, rollback\]/u);
  assert.doesNotMatch(rollout, /eas build|eas submit/u);
});

test('M60-04 workflow secret and logging contract is fail closed', () => {
  const all = Object.values(sources).join('\n');
  for (const forbidden of [
    'PERSONAL_ACCESS_TOKEN',
    'GH_PAT',
    'EXPO_PERSONAL_TOKEN',
    'ubuntu-latest',
    'macos-latest',
    'pnpm add -g',
  ])
    assert.doesNotMatch(all, new RegExp(forbidden));
  assert.doesNotMatch(all, /echo\s+['"]?\$\{\{\s*secrets\./u);
  assert.match(all, /no external|no external command|no external submission/iu);
});

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
  assert.doesNotThrow(() => validateMobileSubmitCredentials('android-enterprise', {
    ENTERPRISE_MDM_ROBOT_TOKEN: 'robot-token',
    MOBILE_ENTERPRISE_SUBMIT_ENDPOINT: 'https://mdm.example.com/mobile/upload',
    ANDROID_PLAY_SERVICE_ACCOUNT_JSON: '',
  }));
  assert.throws(() => validateMobileSubmitCredentials('android-enterprise', {
    ENTERPRISE_MDM_ROBOT_TOKEN: 'robot-token',
    MOBILE_ENTERPRISE_SUBMIT_ENDPOINT: 'http://user:password@mdm.example.com/upload',
  }), /credential-free HTTPS/u);

  const submit = sources['.github/workflows/mobile-submit.yml'];
  assert.match(submit, /node mobile\/scripts\/mobile-submit-credential-policy\.mjs "\$PROFILE"/u);
  const submitSteps = parsed['.github/workflows/mobile-submit.yml'].jobs.submit.steps;
  const checkoutIndex = submitSteps.findIndex((step) => step.uses === 'actions/checkout@v5');
  const credentialPolicyIndex = submitSteps.findIndex((step) =>
    step.run?.includes('mobile-submit-credential-policy.mjs'));
  assert.equal(checkoutIndex, 0, 'real submit must checkout the reviewed commit before any repository script');
  assert.equal(submitSteps[checkoutIndex].with.ref, '${{ needs.validate-boundary.outputs.commit }}');
  assert.ok(credentialPolicyIndex > checkoutIndex, 'credential policy must run after checkout');
  for (const variable of [
    'APP_STORE_CONNECT_API_KEY_P8',
    'APP_STORE_CONNECT_API_KEY_ID',
    'APP_STORE_CONNECT_ISSUER_ID',
    'ANDROID_PLAY_SERVICE_ACCOUNT_JSON',
    'ENTERPRISE_MDM_ROBOT_TOKEN',
    'MOBILE_ENTERPRISE_SUBMIT_ENDPOINT',
  ]) assert.match(submit, new RegExp(variable, 'u'));
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
