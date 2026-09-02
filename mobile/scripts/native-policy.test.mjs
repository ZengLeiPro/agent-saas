import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkNativeTree } from './native-policy-lib.mjs';

const require = createRequire(import.meta.url);
const { applyAndroidDistributionContract, applyAndroidSigningConfig } = require('../plugins/withAndroidSigningConfig');
const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, '..');
const CHECKER = join(HERE, 'check-native-policy.mjs');
const TEAM_ID = 'TESTTEAM01';
const APP_GROUP = 'group.test-fixture.com.agentsaas.mobile';

function write(root, path, contents) {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function plist(value) {
  const encode = (entry) => {
    if (entry === true) return '<true/>';
    if (entry === false) return '<false/>';
    if (typeof entry === 'number') return `<integer>${entry}</integer>`;
    if (typeof entry === 'string') return `<string>${entry}</string>`;
    if (Array.isArray(entry)) return `<array>${entry.map(encode).join('')}</array>`;
    return `<dict>${Object.entries(entry).map(([key, item]) => `<key>${key}</key>${encode(item)}`).join('')}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${encode(value)}</plist>`;
}

function createAndroidFixture(profile) {
  const root = mkdtempSync(join(tmpdir(), `m60-03-${profile}-`));
  const install = profile === 'enterprise'
    ? '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>'
    : '';
  write(root, 'android/app/src/main/AndroidManifest.xml', `<?xml version="1.0"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission android:name="android.permission.CAMERA"/>
  <uses-permission android:name="android.permission.RECORD_AUDIO"/>
  <uses-permission android:name="android.permission.USE_BIOMETRIC"/>${install}
  <application android:allowBackup="false" android:fullBackupContent="@xml/m10_05_backup_rules" android:dataExtractionRules="@xml/m10_05_data_extraction_rules" android:usesCleartextTraffic="false">
    <activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/></intent-filter></activity>
    <provider android:name="androidx.core.content.FileProvider" android:authorities="com.agentsaas.mobile.fileprovider" android:exported="false" android:grantUriPermissions="true"/>
  </application>
</manifest>`);
  write(root, 'android/app/src/main/res/xml/m10_05_backup_rules.xml', '<full-backup-content><exclude domain="root" path="."/></full-backup-content>');
  write(root, 'android/app/src/main/res/xml/m10_05_data_extraction_rules.xml', '<data-extraction-rules><cloud-backup disableIfNoEncryptionCapabilities="false"><exclude domain="root" path="."/></cloud-backup><device-transfer><exclude domain="root" path="."/></device-transfer></data-extraction-rules>');
  const artifact = profile === 'store' ? 'aab' : 'apk';
  const expoGradle = `android {
  namespace "com.agentsaas.mobile"
  defaultConfig {
    applicationId "com.agentsaas.mobile"
  }
  signingConfigs {
    debug {
      storeFile file('debug.keystore')
    }
  }
  buildTypes {
    debug {
      signingConfig signingConfigs.debug
    }
    release {
      signingConfig signingConfigs.debug
    }
  }
}`;
  const signed = applyAndroidSigningConfig(expoGradle);
  write(root, 'android/app/build.gradle', applyAndroidDistributionContract(signed, {
    flavor: profile,
    artifactType: artifact,
  }));
  return root;
}

function privacyManifest() {
  return {
    NSPrivacyAccessedAPITypes: [{
      NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
      NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
    }],
    NSPrivacyCollectedDataTypes: [],
    NSPrivacyTracking: false,
    NSPrivacyTrackingDomains: [],
  };
}

// Mirrors Expo's generated Xcode identity plus canonical URL schemes.
function createIosFixture() {
  const root = mkdtempSync(join(tmpdir(), 'm60-03-ios-'));
  mkdirSync(join(root, 'ios/AgentSaaS.xcodeproj'), { recursive: true });
  write(root, 'ios/AgentSaaS.xcodeproj/project.pbxproj', `
PRODUCT_BUNDLE_IDENTIFIER = com.agentsaas.mobile;
PRODUCT_BUNDLE_IDENTIFIER = com.agentsaas.mobile.shareextension;
DEVELOPMENT_TEAM = ${TEAM_ID};
`);
  write(root, 'ios/AgentSaaS/Info.plist', plist({
    CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)',
    CFBundleURLTypes: [{ CFBundleURLSchemes: ['agent-saas', 'com.agentsaas.mobile'] }],
    NSCameraUsageDescription: '用于在用户选择拍照时拍摄并上传附件',
    NSFaceIDUsageDescription: '用于在您明确开启应用锁后，以 Face ID 解锁本机上的 Agent SaaS 界面',
    NSMicrophoneUsageDescription: '用于录制并发送语音消息',
    NSPhotoLibraryUsageDescription: '用于在用户选择图库时选取图片或视频作为附件、头像',
  }));
  write(root, 'ios/AgentSaaS/AgentSaaS.entitlements', plist({
    'com.apple.security.application-groups': [APP_GROUP],
    'keychain-access-groups': [`$(AppIdentifierPrefix)${APP_GROUP}`],
  }));
  write(root, 'ios/AgentSaaS/PrivacyInfo.xcprivacy', plist(privacyManifest()));
  return root;
}

function runChecker(root, profile, extra = []) {
  const jsonPath = join(root, 'result.json');
  const result = spawnSync(process.execPath, [
    CHECKER,
    '--root', root,
    '--profile', profile,
    '--json', jsonPath,
    '--evidence', 'test-fixture',
    '--team-id', TEAM_ID,
    '--app-group', APP_GROUP,
    '--no-golden',
    ...extra,
  ], { cwd: MOBILE_ROOT, encoding: 'utf8' });
  return { process: result, report: JSON.parse(readFileSync(jsonPath, 'utf8')) };
}

for (const profile of ['store', 'enterprise', 'ios']) {
  test(`M60-03 normal generated ${profile} fixture passes`, () => {
    const root = profile === 'ios' ? createIosFixture() : createAndroidFixture(profile);
    try {
      const result = checkNativeTree({
        root,
        profile,
        compareGolden: false,
        evidence: { classification: 'test-fixture', teamId: TEAM_ID, appGroup: APP_GROUP },
      });
      assert.equal(result.ok, true, JSON.stringify(result.findings));
      assert.equal(result.evidence.releaseEvidence, false);
      assert.equal(result.input.root, '<generated-root>');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

const androidMutations = [
  ['debug signer', 'store', 'android/app/build.gradle', 'signingConfig signingConfigs.release', 'signingConfig signingConfigs.debug', 'ANDROID_RELEASE_DEBUG_SIGNER'],
  ['cleartext', 'store', 'android/app/src/main/AndroidManifest.xml', 'usesCleartextTraffic="false"', 'usesCleartextTraffic="true"', 'ANDROID_CLEARTEXT_ENABLED'],
  ['backup', 'store', 'android/app/src/main/AndroidManifest.xml', 'allowBackup="false"', 'allowBackup="true"', 'ANDROID_BACKUP_ENABLED'],
  ['Store install permission', 'store', 'android/app/src/main/AndroidManifest.xml', '<application ', '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/><application ', 'ANDROID_STORE_INSTALL_PERMISSION'],
  ['exported receiver', 'store', 'android/app/src/main/AndroidManifest.xml', '</application>', '<receiver android:name=".InjectedReceiver" android:exported="true"/></application>', 'ANDROID_EXPORTED_COMPONENT_UNEXPECTED'],
];

for (const [name, profile, path, before, after, code] of androidMutations) {
  test(`M60-03 mutation ${name} exits non-zero with ${code}`, () => {
    const root = createAndroidFixture(profile);
    try {
      const file = join(root, path);
      writeFileSync(file, readFileSync(file, 'utf8').replace(before, after));
      const result = runChecker(root, profile);
      assert.equal(result.process.status, 1);
      assert.ok(result.report.findings.some((entry) => entry.code === code), JSON.stringify(result.report.findings));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

const iosMutations = [
  ['arbitrary loads', 'Info.plist', '</dict></plist>', '<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict></dict></plist>', 'IOS_ATS_ARBITRARY_LOADS'],
  ['Always Location', 'Info.plist', '</dict></plist>', '<key>NSLocationAlwaysUsageDescription</key><string>injected</string></dict></plist>', 'IOS_USAGE_LOCATION_ALWAYS'],
  ['PrivacyInfo reason removal', 'PrivacyInfo.xcprivacy', '<string>CA92.1</string>', '', 'IOS_PRIVACY_REASON_MISSING'],
];

for (const [name, fileName, before, after, code] of iosMutations) {
  test(`M60-03 mutation ${name} exits non-zero with ${code}`, () => {
    const root = createIosFixture();
    try {
      const file = join(root, `ios/AgentSaaS/${fileName}`);
      writeFileSync(file, readFileSync(file, 'utf8').replace(before, after));
      const result = runChecker(root, 'ios');
      assert.equal(result.process.status, 1);
      assert.ok(result.report.findings.some((entry) => entry.code === code), JSON.stringify(result.report.findings));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

test('M60-03 generated tree symlink fails closed', () => {
  const root = createAndroidFixture('store');
  try {
    symlinkSync('AndroidManifest.xml', join(root, 'android/app/src/main/manifest-link.xml'));
    const result = checkNativeTree({ root, profile: 'store', compareGolden: false });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((entry) => entry.code === 'INPUT_SYMLINK'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('M60-03 traversal spelling fails closed even when it resolves inside the fixture', () => {
  const root = createAndroidFixture('store');
  try {
    const traversed = `${root}/android/..`;
    const result = checkNativeTree({ root: traversed, profile: 'store', compareGolden: false });
    assert.equal(result.ok, false);
    assert.ok(result.findings.some((entry) => entry.code === 'INPUT_PATH_TRAVERSAL'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('M60-03 reviewed golden drift exits non-zero with GOLDEN_DRIFT', () => {
  const root = createAndroidFixture('store');
  try {
    const baseline = checkNativeTree({ root, profile: 'store', compareGolden: false, evidence: { classification: 'test-fixture' } });
    const golden = join(root, 'drifted-golden.json');
    const drifted = structuredClone(baseline.normalized);
    drifted.android.gradle.artifactType = 'apk';
    writeFileSync(golden, JSON.stringify(drifted));
    const jsonPath = join(root, 'golden-result.json');
    const processResult = spawnSync(process.execPath, [
      CHECKER, '--root', root, '--profile', 'store', '--json', jsonPath,
      '--evidence', 'test-fixture', '--team-id', TEAM_ID, '--app-group', APP_GROUP,
      '--golden', golden,
    ], { cwd: MOBILE_ROOT, encoding: 'utf8' });
    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.equal(processResult.status, 1);
    assert.ok(report.findings.some((entry) => entry.code === 'GOLDEN_DRIFT'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
