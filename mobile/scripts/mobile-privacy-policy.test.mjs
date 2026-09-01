import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  verifyAndroidBackupRulesText,
  verifyAndroidManifestText,
  verifyProductionIosTexts,
} from './verify-mobile-privacy-prebuild.mjs';

const require = createRequire(import.meta.url);
const {
  DATA_EXTRACTION_RULES,
  FULL_BACKUP_RULES,
} = require('../plugins/withMobilePrivacyControls');
const { createExpoConfig, loadRepositoryInputs } = require('./release-manifest.cjs');

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY_ROOT = resolve(MOBILE_ROOT, '..');
const FULL_GIT_SHA = '1234567890abcdef1234567890abcdef12345678';

function readMobile(path) {
  return readFileSync(resolve(MOBILE_ROOT, path), 'utf8');
}

function listRuntimeSource(root) {
  const files = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...listRuntimeSource(path));
    else if (/\.(?:ts|tsx)$/.test(path) && !/\.test\.(?:ts|tsx)$/.test(path)) files.push(path);
  }
  return files;
}

function productionManifest(distribution = 'store') {
  const { manifest } = loadRepositoryInputs();
  const fixture = structuredClone(manifest);
  fixture.version.androidVersionCode = 86;
  fixture.version.latestPublished = {
    marketingVersion: '1.9.4',
    iosBuildNumber: 84,
    androidVersionCode: 85,
  };
  fixture.oauthCallback.profiles.production = ['https://mobile.example.test/oauth/callback'];
  fixture.target = {
    profile: 'production',
    distribution,
    gitSha: FULL_GIT_SHA,
  };
  fixture.verification = {
    identity: 'verified',
    versions: 'verified',
    distribution: 'verified',
  };
  return fixture;
}

function pluginOptions(config, name) {
  const plugin = config.plugins.find((entry) => (Array.isArray(entry) ? entry[0] : entry) === name);
  return Array.isArray(plugin) ? plugin[1] : undefined;
}

function validAndroidManifest() {
  return `<?xml version="1.0"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" xmlns:tools="http://schemas.android.com/tools">
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission android:name="android.permission.CAMERA"/>
  <uses-permission android:name="android.permission.RECORD_AUDIO"/>
  <uses-permission android:name="android.permission.USE_BIOMETRIC"/>
  <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/>
  <uses-permission android:name="android.permission.VIBRATE"/>
  <application android:allowBackup="false" android:fullBackupContent="@xml/m10_05_backup_rules" android:dataExtractionRules="@xml/m10_05_data_extraction_rules" android:usesCleartextTraffic="false">
  </application>
</manifest>`;
}

const VALID_IOS_INFO = `<?xml version="1.0"?><plist><dict>
<key>NSCameraUsageDescription</key><string>用于在用户选择拍照时拍摄并上传附件</string>
<key>NSMicrophoneUsageDescription</key><string>用于录制并发送语音消息</string>
<key>NSPhotoLibraryUsageDescription</key><string>用于在用户选择图库时选取图片或视频作为附件、头像</string>
<key>NSFaceIDUsageDescription</key><string>用于在您明确开启应用锁后，以 Face ID 解锁本机上的 Agent SaaS 界面</string>
</dict></plist>`;
const VALID_IOS_ENTITLEMENTS = `<?xml version="1.0"?><plist><dict>
<key>com.apple.security.application-groups</key><array><string>group.fixture</string></array>
<key>keychain-access-groups</key><array><string>$(AppIdentifierPrefix)group.fixture</string></array>
</dict></plist>`;
const VALID_PRIVACY_INFO = `<?xml version="1.0"?><plist><dict>
<key>NSPrivacyAccessedAPITypes</key><array><dict>
<key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryUserDefaults</string>
<key>NSPrivacyAccessedAPITypeReasons</key><array><string>CA92.1</string></array>
</dict></array>
<key>NSPrivacyCollectedDataTypes</key><array/>
<key>NSPrivacyTracking</key><false/>
<key>NSPrivacyTrackingDomains</key><array/>
</dict></plist>`;

function validIosArtifacts(overrides = {}) {
  return {
    infoPlist: VALID_IOS_INFO,
    entitlements: VALID_IOS_ENTITLEMENTS,
    privacyInfo: VALID_PRIVACY_INFO,
    pbxProject: 'path = PrivacyInfo.xcprivacy;',
    // M60-03 structurally re-checks this fixture and rejects reason removal.
    ...overrides,
  };
}

test('M10-05 runtime source has no location dependency, startup request, or activity-log location path', () => {
  const packageJson = JSON.parse(readMobile('package.json'));
  assert.equal(packageJson.dependencies['expo-location'], undefined);
  assert.doesNotMatch(
    readFileSync(resolve(REPOSITORY_ROOT, 'pnpm-lock.yaml'), 'utf8'),
    /expo-location/,
  );

  const appConfig = JSON.parse(readMobile('app.json')).expo;
  const plugins = appConfig.plugins.map((entry) => (Array.isArray(entry) ? entry[0] : entry));
  assert.equal(plugins.includes('expo-location'), false);
  assert.deepEqual(appConfig.android.permissions.sort(), [
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
  ]);
  assert.equal(appConfig.ios.infoPlist.NSLocationWhenInUseUsageDescription, undefined);
  assert.equal(appConfig.ios.infoPlist.LSApplicationQueriesSchemes, undefined);
  assert.equal(existsSync(resolve(MOBILE_ROOT, 'app/chat/html-preview.tsx')), false);
  assert.equal(existsSync(resolve(MOBILE_ROOT, 'src/services/previewTokenCache.ts')), false);
  assert.doesNotMatch(readMobile('src/components/chat/MessageItem.tsx'), /\/chat\/html-preview|preview-token/);

  const runtimeFiles = [
    ...listRuntimeSource(resolve(MOBILE_ROOT, 'app')),
    ...listRuntimeSource(resolve(MOBILE_ROOT, 'src')),
  ];
  for (const path of runtimeFiles) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(
      source,
      /from ['"]expo-location['"]|\bLocation\.(?:request|get)|iosamap:\/\//,
      relative(MOBILE_ROOT, path),
    );
  }

  const activityReporter = readMobile('src/hooks/useActivityReporter.ts');
  assert.doesNotMatch(
    activityReporter,
    /request\w*Permission|ActivityLocation|\bLocation\.|\{\s*location[,}]/,
  );
  const auditList = readMobile('src/components/audit/AuditLogList.tsx');
  assert.doesNotMatch(auditList, /item\.location|wgs84ToGcj02|openLocationInAmap/);

  for (const startupPath of [
    'app/_layout.tsx',
    'app/index.tsx',
    'app/login.tsx',
    'src/contexts/AuthContext.tsx',
  ]) {
    assert.doesNotMatch(
      readMobile(startupPath),
      /request\w*Permissions?Async|launch(?:Camera|ImageLibrary)ForUserAction/,
      startupPath,
    );
  }
});

test('M10-05 permission-capable APIs are centralized and called only by named user-action paths', () => {
  const runtimeFiles = [
    ...listRuntimeSource(resolve(MOBILE_ROOT, 'app')),
    ...listRuntimeSource(resolve(MOBILE_ROOT, 'src')),
  ];
  const nativeApiPattern =
    /(?:requestRecordingPermissionsAsync|requestCameraPermissionsAsync|getCameraPermissionsAsync|launchCameraAsync|launchImageLibraryAsync)/;
  const nativeApiFiles = runtimeFiles
    .filter((path) => nativeApiPattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(MOBILE_ROOT, path));
  assert.deepEqual(nativeApiFiles, ['src/platform/jitMediaPermissions.ts']);

  const voice = readMobile('src/hooks/useVoiceRecorder.ts');
  assert.match(
    voice,
    /const startRecording = useCallback[\s\S]*requestMicrophoneForUserAction\(\)/,
  );
  const upload = readMobile('src/hooks/useFileUpload.ts');
  assert.match(upload, /const pickImage = useCallback[\s\S]*launchPhotoLibraryForUserAction\(/);
  assert.match(upload, /const takePhoto = useCallback[\s\S]*launchCameraForUserAction\(/);
  assert.match(
    readMobile('src/components/settings/AgentProfileEditor.tsx'),
    /handlePickAvatar[\s\S]*launchPhotoLibraryForUserAction\(/,
  );
  assert.match(
    readMobile('app/settings/user-detail/[userId].tsx'),
    /handleAvatarUpload[\s\S]*launchPhotoLibraryForUserAction\(/,
  );

  const chatInput = readMobile('src/components/chat/ChatInput.tsx');
  const textSendPath = chatInput.match(/const handleSend = \(\) => \{[\s\S]*?\n  \};/)?.[0] ?? '';
  assert.match(textSendPath, /onSend\(\)/);
  assert.doesNotMatch(textSendPath, /Permission|Microphone|Camera|PhotoLibrary/);
});

test('M10-05 Expo config profiles cleartext and backup without weakening production', () => {
  const { manifest, staticExpoConfig } = loadRepositoryInputs();
  const preview = createExpoConfig(staticExpoConfig, {
    manifest,
    context: {
      profile: 'preview',
      platform: 'android',
      distribution: 'store',
      sourceGitSha: FULL_GIT_SHA,
    },
  });
  assert.equal(preview.android.usesCleartextTraffic, true);
  assert.equal(preview.android.allowBackup, false);

  const production = createExpoConfig(staticExpoConfig, {
    manifest: productionManifest('store'),
    context: {
      profile: 'production',
      platform: 'android',
      distribution: 'store',
      sourceGitSha: FULL_GIT_SHA,
      enterpriseUpdater: { enabled: false },
    },
  });
  assert.equal(production.android.usesCleartextTraffic, false);
  assert.equal(production.android.allowBackup, false);
  assert.equal(production.extra.enterpriseUpdater, undefined);
  assert.equal(
    production.android.permissions.includes('android.permission.REQUEST_INSTALL_PACKAGES'),
    false,
  );

  assert.deepEqual(pluginOptions(production, 'expo-audio'), {
    microphonePermission: '用于录制并发送语音消息',
    recordAudioAndroid: true,
    enableBackgroundRecording: false,
    enableBackgroundPlayback: false,
  });
  assert.deepEqual(pluginOptions(production, 'expo-video'), {
    supportsBackgroundPlayback: false,
    supportsPictureInPicture: false,
  });
  assert.deepEqual(pluginOptions(production, 'expo-secure-store'), {
    faceIDPermission: false,
    configureAndroidBackup: false,
  });
  assert.deepEqual(pluginOptions(production, 'expo-local-authentication'), {
    faceIDPermission: '用于在您明确开启应用锁后，以 Face ID 解锁本机上的 Agent SaaS 界面',
  });
  assert.deepEqual(production.ios.privacyManifests, {
    NSPrivacyAccessedAPITypes: [
      {
        NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
        NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
      },
    ],
    NSPrivacyCollectedDataTypes: [],
    NSPrivacyTracking: false,
    NSPrivacyTrackingDomains: [],
  });
});

test('M10-05 Android static gate rejects cleartext, backup, permission, service, and Store install injection', () => {
  const options = { profile: 'production', distribution: 'store', updater: 'disabled' };
  assert.doesNotThrow(() => verifyAndroidManifestText(validAndroidManifest(), options));
  assert.equal(verifyAndroidBackupRulesText(FULL_BACKUP_RULES, DATA_EXTRACTION_RULES), true);

  assert.throws(
    () =>
      verifyAndroidManifestText(
        validAndroidManifest().replace('allowBackup="false"', 'allowBackup="true"'),
        options,
      ),
    /allowBackup/,
  );
  assert.throws(
    () =>
      verifyAndroidManifestText(
        validAndroidManifest().replace(
          'usesCleartextTraffic="false"',
          'usesCleartextTraffic="true"',
        ),
        options,
      ),
    /usesCleartextTraffic/,
  );
  assert.throws(
    () =>
      verifyAndroidManifestText(
        validAndroidManifest().replace(
          '<application',
          '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>\n<application',
        ),
        options,
      ),
    /unexpected permissions/,
  );
  assert.throws(
    () =>
      verifyAndroidManifestText(
        validAndroidManifest().replace(
          '</application>',
          '<service android:foregroundServiceType="mediaPlayback"/></application>',
        ),
        options,
      ),
    /foreground-service/,
  );
  assert.throws(
    () =>
      verifyAndroidManifestText(
        validAndroidManifest().replace(
          '<application',
          `<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>\n<application`,
        ),
        options,
      ),
    /install permission count/,
  );
  assert.throws(
    () =>
      verifyAndroidBackupRulesText(
        FULL_BACKUP_RULES.replace('sharedpref', 'sharedprefs'),
        DATA_EXTRACTION_RULES,
      ),
    /backup rules drifted/,
  );
});

test('M10-05 iOS static gate rejects production exceptions, background audio, entitlement injection, and PrivacyInfo drift', () => {
  assert.doesNotThrow(() => verifyProductionIosTexts(validIosArtifacts()));
  assert.throws(
    () =>
      verifyProductionIosTexts(
        validIosArtifacts({
          infoPlist: VALID_IOS_INFO.replace(
            '</dict>',
            '<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict>',
          ),
        }),
      ),
    /NSAppTransportSecurity/,
  );
  assert.throws(
    () =>
      verifyProductionIosTexts(
        validIosArtifacts({
          infoPlist: VALID_IOS_INFO.replace(
            '</dict>',
            '<key>NSLocationWhenInUseUsageDescription</key><string>fixture</string></dict>',
          ),
        }),
      ),
    /NSLocationWhenInUseUsageDescription/,
  );
  assert.throws(
    () =>
      verifyProductionIosTexts(
        validIosArtifacts({
          infoPlist: VALID_IOS_INFO.replace(
            '</dict>',
            '<key>UIBackgroundModes</key><array><string>audio</string></array></dict>',
          ),
        }),
      ),
    /background audio/,
  );
  assert.throws(
    () =>
      verifyProductionIosTexts(
        validIosArtifacts({
          entitlements: VALID_IOS_ENTITLEMENTS.replace(
            '</dict>',
            '<key>com.apple.developer.healthkit</key><true/></dict>',
          ),
        }),
      ),
    /unexpected keys/,
  );
  assert.throws(
    () =>
      verifyProductionIosTexts(
        validIosArtifacts({
          privacyInfo: VALID_PRIVACY_INFO.replace('<string>CA92.1</string>', ''),
        }),
      ),
    /missing the reviewed UserDefaults CA92\.1 reason/,
  );
});

test('M10-05 review document keeps every external privacy and system-support fact pending', () => {
  const review = readFileSync(
    resolve(REPOSITORY_ROOT, 'docs/mobile-m10-05-privacy-and-store-review.md'),
    'utf8',
  );
  assert.match(review, /Google Play Data Safety/);
  assert.match(review, /没有代填任何答案/);
  assert.match(review, /iPad 支持口径/);
  assert.match(review, /最低系统版本/);
  assert.match(review, /真实 cloud backup \/ restore/);
  assert.match(review, /M30-01\/M30-02/);
  assert.doesNotMatch(review, /- \[x\]/i);
});
