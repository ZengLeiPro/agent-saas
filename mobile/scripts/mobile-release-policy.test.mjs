import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';
import { validateMobileSubmitCredentials } from './mobile-submit-credential-policy.mjs';
import { validateProtection } from './ios-actions-policy.mjs';
import './ios-actions.test.mjs';

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
  assert.match(verifier, /signed App Group entitlement mismatch/u);
  assert.match(verifier, /signed Keychain Group entitlement mismatch/u);
  assert.match(verifier, /provisioning profile Apple Team mismatch/u);
  assert.match(verifier, /provisioning profile is not App Store distribution/u);
  assert.match(verifier, /provisioning profile is expired or invalid/u);
  assert.match(verifier, /signer is absent from its provisioning profile/u);
  assert.match(verifier, /embedded provisioning profile missing/u);
  assert.match(verifier, /verify_ios_store_profile .* share-extension /u);
  assert.match(verifier, /main-app.*production/u);
  assert.match(verifier, /signed APNs environment must be production/u);
  assert.match(verifier, /provisioning profile APNs environment must be production/u);
  assert.match(verifier, /Share Extension bundle identifier mismatch/u);
  assert.match(verifier, /IPA signed source Git SHA mismatch/u);
  assert.match(verifier, /\$label signed development entitlement rejected/u);
  assert.match(verifier, /share-extension.*absent/u);
  assert.match(verifier, /\$label unexpected push entitlement/u);
});

test('M60-04 iOS build and submit are separate fail-closed operations', () => {
  const build = readFileSync(resolve(root, 'mobile/scripts/build.sh'), 'utf8');
  const submit = readFileSync(resolve(root, 'mobile/scripts/submit-ios.sh'), 'utf8');
  assert.doesNotMatch(build, /eas submit/u);
  assert.match(build, /scripts\/submit-ios\.sh/u);
  assert.match(build, /merge-base --is-ancestor/u);
  assert.match(build, /verify-mobile-release-artifact\.sh/u);
  assert.match(submit, /verify-mobile-release-artifact\.sh/u);
  assert.match(submit, /cmp -s/u);
  assert.match(submit, /IPA source sidecar does not match the reviewed manifest at current HEAD/u);
  assert.match(submit, /--print-artifact-identity/u);
  assert.match(submit, /SUBMIT_IPA/u);
  assert.match(submit, /chmod 400/u);
  assert.match(submit, /exec 9<"\$SUBMIT_IPA"/u);
  assert.match(submit, /unlink "\$SUBMIT_IPA"/u);
  assert.match(submit, /--path \/dev\/fd\/9/u);
  assert.match(submit, /require\.resolve\("eas-cli\/bin\/run"\)/u);
  assert.match(submit, /no success receipt log was written/u);
  assert.match(submit, /Current checkout does not match the IPA source commit/u);
  assert.match(submit, /merge-base --is-ancestor/u);
  assert.match(submit, /"\$EAS_CLI_ENTRY" submit -p ios/u);
  assert.doesNotMatch(submit, /eas build/u);
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
  assert.equal(eas.build.production.ios.image, 'macos-sequoia-15.6-xcode-26.2');
  assert.equal(eas.build.production.distribution, 'store');
  assert.equal(eas.build.production.ios.credentialsSource, 'remote');
  assert.equal(eas.build['production-store'].android.image, 'ubuntu-24.04-jdk-17-ndk-r27b-sdk-55');
  assert.equal(
    eas.build['production-enterprise'].android.image,
    'ubuntu-24.04-jdk-17-ndk-r27b-sdk-55',
  );
  assert.equal(eas.build['production-store'].android.buildType, 'app-bundle');
  assert.equal(eas.build['production-enterprise'].android.buildType, 'apk');
});

test('iOS approval accepts the documented REST response without inventing a bypass field', () => {
  const environment = {
    id: 7, name: 'mobile-build-production',
    protection_rules: [{ type: 'required_reviewers', prevent_self_review: true,
      reviewers: [{ type: 'User', reviewer: { login: 'reviewer' } }] }],
    deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
  };
  const approval = { state: 'approved', user: { login: 'Reviewer' },
    environments: [{ id: 7, name: environment.name }] };
  const expected = { environment: environment.name, actor: 'author', triggeringActor: 'rerunner' };
  assert.doesNotThrow(() => validateProtection(environment, [approval], expected));
  assert.throws(() => validateProtection(environment, [{ ...approval, user: { login: 'unlisted-admin' } }], expected));
  assert.throws(() => validateProtection(environment, [approval], { ...expected, actor: 'REVIEWER' }));
  const team = structuredClone(environment);
  team.protection_rules[0].reviewers = [{ type: 'Team', reviewer: { slug: 'release' } }];
  assert.throws(() => validateProtection(team, [approval], expected), /named User/u);
  assert.throws(() => validateProtection(environment, [], expected), /No independent named/u);
});

test('iOS dependency-free contract and planning jobs do not cache nonexistent stores', () => {
  const workflow = readFileSync(resolve(root, '.github/workflows/mobile-ios-release.yml'), 'utf8');
  const contracts = workflow.split('  contract:')[1].split('  plan:')[0];
  const planning = workflow.split('  plan:')[1].split('  build_ios:')[0];
  assert.match(contracts, /package-manager-cache: false/u);
  assert.match(planning, /package-manager-cache: false/u);
});
