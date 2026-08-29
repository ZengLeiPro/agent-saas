#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DATA_EXTRACTION_RULES,
  DATA_EXTRACTION_RULES_RESOURCE,
  FULL_BACKUP_RULES,
  FULL_BACKUP_RULES_RESOURCE,
} = require('../plugins/withMobilePrivacyControls');

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_MANIFEST_PATH = join(MOBILE_ROOT, 'android/app/src/main/AndroidManifest.xml');
const ANDROID_XML_ROOT = join(MOBILE_ROOT, 'android/app/src/main/res/xml');
const INSTALL_PERMISSION = 'android.permission.REQUEST_INSTALL_PACKAGES';
const REQUIRED_ANDROID_PERMISSIONS = new Set([
  'android.permission.CAMERA',
  'android.permission.INTERNET',
  'android.permission.RECORD_AUDIO',
]);
const ALLOWED_ANDROID_PERMISSIONS = new Set([
  ...REQUIRED_ANDROID_PERMISSIONS,
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.VIBRATE',
  INSTALL_PERMISSION,
]);
const ALLOWED_IOS_ENTITLEMENTS = new Set([
  'com.apple.developer.associated-domains',
  'com.apple.security.application-groups',
  'keychain-access-groups',
]);
const FORBIDDEN_IOS_INFO_KEYS = Object.freeze([
  'NSAppTransportSecurity',
  'NSBonjourServices',
  'NSFaceIDUsageDescription',
  'NSLocalNetworkUsageDescription',
  'NSLocationAlwaysAndWhenInUseUsageDescription',
  'NSLocationAlwaysUsageDescription',
  'NSLocationTemporaryUsageDescriptionDictionary',
  'NSLocationWhenInUseUsageDescription',
]);
const REQUIRED_IOS_USAGE_DESCRIPTIONS = Object.freeze({
  NSCameraUsageDescription: '用于在用户选择拍照时拍摄并上传附件',
  NSMicrophoneUsageDescription: '用于录制并发送语音消息',
  NSPhotoLibraryUsageDescription: '用于在用户选择图库时选取图片或视频作为附件、头像',
});

function fail(message) {
  throw new Error(`[M10-05] ${message}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseXmlAttributes(fragment) {
  const attributes = new Map();
  const pattern = /([:\w.-]+)\s*=\s*(["'])(.*?)\2/g;
  for (const match of fragment.matchAll(pattern)) attributes.set(match[1], match[3]);
  return attributes;
}

function parseAndroidPermissions(manifest) {
  return [...manifest.matchAll(/<uses-permission\b([^>]*)\/?\s*>/g)].map((match) => {
    const attributes = parseXmlAttributes(match[1]);
    return {
      name: attributes.get('android:name') ?? '',
      removed: attributes.get('tools:node') === 'remove',
    };
  });
}

export function verifyAndroidManifestText(
  manifest,
  { profile = 'production', distribution, updater },
) {
  const applicationMatch = manifest.match(/<application\b([^>]*)>/);
  if (!applicationMatch) fail('generated AndroidManifest.xml has no application element');
  const appAttributes = parseXmlAttributes(applicationMatch[1]);
  if (appAttributes.get('android:allowBackup') !== 'false') {
    fail('Android application must set android:allowBackup="false"');
  }
  if (appAttributes.get('android:fullBackupContent') !== `@xml/${FULL_BACKUP_RULES_RESOURCE}`) {
    fail('Android legacy full-backup rules are not the M10-05 deny-all resource');
  }
  if (
    appAttributes.get('android:dataExtractionRules') !== `@xml/${DATA_EXTRACTION_RULES_RESOURCE}`
  ) {
    fail('Android data-extraction rules are not the M10-05 deny-all resource');
  }

  const expectedCleartext = profile === 'production' ? 'false' : 'true';
  if (appAttributes.get('android:usesCleartextTraffic') !== expectedCleartext) {
    fail(`Android ${profile} must set android:usesCleartextTraffic="${expectedCleartext}"`);
  }
  if (profile === 'production' && appAttributes.has('android:networkSecurityConfig')) {
    fail('Android production must not carry a network security cleartext exception');
  }

  const permissionEntries = parseAndroidPermissions(manifest);
  const effectivePermissions = permissionEntries
    .filter((entry) => !entry.removed)
    .map((entry) => entry.name);
  for (const permission of REQUIRED_ANDROID_PERMISSIONS) {
    if (!effectivePermissions.includes(permission)) {
      fail(`Android generated manifest is missing required JIT capability ${permission}`);
    }
  }
  const unexpected = effectivePermissions.filter(
    (permission) => !ALLOWED_ANDROID_PERMISSIONS.has(permission),
  );
  if (unexpected.length) {
    fail(`Android generated manifest contains unexpected permissions: ${unexpected.join(', ')}`);
  }

  const installCount = effectivePermissions.filter(
    (permission) => permission === INSTALL_PERMISSION,
  ).length;
  const expectInstall = distribution === 'enterprise' && updater === 'enabled';
  if (installCount !== (expectInstall ? 1 : 0)) {
    fail(
      `${distribution} updater=${updater} install permission count expected ${expectInstall ? 1 : 0}, got ${installCount}`,
    );
  }

  if (/android:foregroundServiceType\s*=/.test(manifest)) {
    fail('Android generated manifest contains a foreground-service declaration');
  }
  if (/expo\.modules\.(?:audio\.service|video\.playbackService)\./.test(manifest)) {
    fail('Android generated manifest contains an unused background media service');
  }
  return { effectivePermissions, installCount };
}

export function verifyAndroidBackupRulesText(legacyRules, extractionRules) {
  if (legacyRules !== FULL_BACKUP_RULES) {
    fail('legacy Android backup rules drifted from the deny-all source');
  }
  if (extractionRules !== DATA_EXTRACTION_RULES) {
    fail('Android 12+ extraction rules drifted from the deny-all source');
  }
  return true;
}

function assertPlistHasString(xml, key, expected) {
  const pattern = new RegExp(
    `<key>${escapeRegExp(key)}</key>\\s*<string>${escapeRegExp(expected)}</string>`,
  );
  if (!pattern.test(xml)) fail(`Info.plist ${key} does not match the audited purpose string`);
}

function assertPlistKeyAbsent(xml, key, label) {
  if (new RegExp(`<key>${escapeRegExp(key)}</key>`).test(xml)) {
    fail(`${label} must not contain ${key}`);
  }
}

export function verifyProductionIosTexts({ infoPlist, entitlements, privacyInfo, pbxProject }) {
  for (const [key, value] of Object.entries(REQUIRED_IOS_USAGE_DESCRIPTIONS)) {
    assertPlistHasString(infoPlist, key, value);
  }
  for (const key of FORBIDDEN_IOS_INFO_KEYS) {
    assertPlistKeyAbsent(infoPlist, key, 'production Info.plist');
  }
  if (infoPlist.includes('iosamap')) {
    fail('production Info.plist must not carry the legacy location-map scheme');
  }
  const backgroundModes = infoPlist.match(
    /<key>UIBackgroundModes<\/key>\s*<array>([\s\S]*?)<\/array>/,
  )?.[1];
  if (backgroundModes && /<string>audio<\/string>/.test(backgroundModes)) {
    fail('production Info.plist must not enable background audio');
  }

  const entitlementKeys = [...entitlements.matchAll(/<key>([^<]+)<\/key>/g)].map(
    (match) => match[1],
  );
  const unexpectedEntitlements = entitlementKeys.filter(
    (key) => !ALLOWED_IOS_ENTITLEMENTS.has(key),
  );
  if (unexpectedEntitlements.length) {
    fail(`main App entitlements contain unexpected keys: ${unexpectedEntitlements.join(', ')}`);
  }
  for (const requiredKey of ['com.apple.security.application-groups', 'keychain-access-groups']) {
    if (!entitlementKeys.includes(requiredKey)) {
      fail(`main App entitlements are missing ${requiredKey}`);
    }
  }

  for (const key of [
    'NSPrivacyAccessedAPITypes',
    'NSPrivacyCollectedDataTypes',
    'NSPrivacyTrackingDomains',
  ]) {
    const emptyArray = new RegExp(`<key>${key}</key>\\s*<array\\s*\\/>`);
    if (!emptyArray.test(privacyInfo)) {
      fail(`main App PrivacyInfo ${key} must remain an explicit pending-review empty array`);
    }
  }
  if (!/<key>NSPrivacyTracking<\/key>\s*<false\s*\/>/.test(privacyInfo)) {
    fail('main App PrivacyInfo must explicitly set NSPrivacyTracking=false');
  }
  if (!pbxProject.includes('PrivacyInfo.xcprivacy')) {
    fail('main App PrivacyInfo.xcprivacy is not linked in the Xcode project');
  }
  return { entitlementKeys };
}

function findFiles(root, predicate) {
  const results = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) results.push(...findFiles(path, predicate));
    else if (entry.isFile() && predicate(path)) results.push(path);
  }
  return results;
}

function parseArguments(argv) {
  const options = { profile: 'production', updater: 'disabled' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!['--platform', '--profile', '--distribution', '--updater'].includes(argument)) {
      fail(`unknown argument ${argument}`);
    }
    if (!value || value.startsWith('--')) fail(`${argument} requires a value`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  if (!['android', 'ios'].includes(options.platform)) fail('--platform must be android or ios');
  if (!['development', 'preview', 'production'].includes(options.profile)) {
    fail('--profile must be development, preview, or production');
  }
  if (!['enabled', 'disabled'].includes(options.updater)) {
    fail('--updater must be enabled or disabled');
  }
  if (options.platform === 'android' && !['store', 'enterprise'].includes(options.distribution)) {
    fail('Android --distribution must be store or enterprise');
  }
  return options;
}

function verifyAndroidGenerated(options) {
  const manifest = readFileSync(ANDROID_MANIFEST_PATH, 'utf8');
  const legacyRules = readFileSync(
    join(ANDROID_XML_ROOT, `${FULL_BACKUP_RULES_RESOURCE}.xml`),
    'utf8',
  );
  const extractionRules = readFileSync(
    join(ANDROID_XML_ROOT, `${DATA_EXTRACTION_RULES_RESOURCE}.xml`),
    'utf8',
  );
  const result = verifyAndroidManifestText(manifest, options);
  verifyAndroidBackupRulesText(legacyRules, extractionRules);
  console.log(
    `M10-05 Android ${options.profile}/${options.distribution} clean prebuild verified ` +
      `(updater=${options.updater}, effectivePermissions=${result.effectivePermissions.length}, backup=deny-all)`,
  );
}

function verifyIosGenerated(options) {
  if (options.profile !== 'production') fail('iOS prebuild verifier currently requires production');
  const iosRoot = join(MOBILE_ROOT, 'ios');
  const xcodeProjects = readdirSync(iosRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && extname(entry.name) === '.xcodeproj')
    .map((entry) => join(iosRoot, entry.name));
  if (xcodeProjects.length !== 1) fail('expected exactly one generated Xcode project');
  const projectName = basename(xcodeProjects[0], '.xcodeproj');
  const appRoot = join(iosRoot, projectName);
  const infoPath = join(appRoot, 'Info.plist');
  const privacyPath = join(appRoot, 'PrivacyInfo.xcprivacy');
  const entitlements = findFiles(appRoot, (path) => path.endsWith('.entitlements'));
  if (entitlements.length !== 1) fail('expected exactly one main App entitlements file');
  verifyProductionIosTexts({
    infoPlist: readFileSync(infoPath, 'utf8'),
    entitlements: readFileSync(entitlements[0], 'utf8'),
    privacyInfo: readFileSync(privacyPath, 'utf8'),
    pbxProject: readFileSync(join(xcodeProjects[0], 'project.pbxproj'), 'utf8'),
  });
  console.log(
    'M10-05 iOS production clean prebuild verified ' +
      '(Info.plist=minimal, entitlements=allowlisted, main PrivacyInfo=pending-review structure)',
  );
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.platform === 'android') verifyAndroidGenerated(options);
  else verifyIosGenerated(options);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[M10-05] privacy prebuild verification failed: ${message}`);
    process.exitCode = 1;
  }
}
