const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withInfoPlist,
} = require('expo/config-plugins');
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');

const FULL_BACKUP_RULES_RESOURCE = 'm10_05_backup_rules';
const DATA_EXTRACTION_RULES_RESOURCE = 'm10_05_data_extraction_rules';

const BLOCKED_ANDROID_PERMISSIONS = Object.freeze([
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_MEDIA_LOCATION',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_CAMERA',
  'android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE',
  'android.permission.FOREGROUND_SERVICE_DATA_SYNC',
  'android.permission.FOREGROUND_SERVICE_HEALTH',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_PHONE_CALL',
  'android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING',
  'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  'android.permission.FOREGROUND_SERVICE_SYSTEM_EXEMPTED',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
]);

const FORBIDDEN_BACKGROUND_SERVICES = new Set([
  'expo.modules.audio.service.AudioControlsService',
  'expo.modules.audio.service.AudioRecordingService',
  'expo.modules.video.playbackService.ExpoVideoPlaybackService',
]);

const ANDROID_BACKUP_DOMAINS = Object.freeze([
  'root',
  'file',
  'database',
  'sharedpref',
  'external',
  'device_root',
  'device_file',
  'device_database',
  'device_sharedpref',
]);

const FULL_BACKUP_RULES = `<?xml version="1.0" encoding="utf-8"?>
<!-- M10-05: fail closed. No application data is eligible for Android backup/restore. -->
<full-backup-content>
${ANDROID_BACKUP_DOMAINS.map((domain) => `  <exclude domain="${domain}" path="." />`).join('\n')}
</full-backup-content>
`;

const DATA_EXTRACTION_RULES = `<?xml version="1.0" encoding="utf-8"?>
<!-- M10-05: deny both cloud backup and device-to-device transfer. -->
<data-extraction-rules>
  <cloud-backup>
${ANDROID_BACKUP_DOMAINS.map((domain) => `    <exclude domain="${domain}" path="." />`).join('\n')}
  </cloud-backup>
  <device-transfer>
${ANDROID_BACKUP_DOMAINS.map((domain) => `    <exclude domain="${domain}" path="." />`).join('\n')}
  </device-transfer>
</data-extraction-rules>
`;

const IOS_LOCATION_USAGE_KEYS = Object.freeze([
  'NSLocationAlwaysAndWhenInUseUsageDescription',
  'NSLocationAlwaysUsageDescription',
  'NSLocationTemporaryUsageDescriptionDictionary',
  'NSLocationWhenInUseUsageDescription',
]);

const IOS_PRODUCTION_ATS_EXCEPTION_KEYS = Object.freeze([
  'NSAllowsArbitraryLoads',
  'NSAllowsArbitraryLoadsForMedia',
  'NSAllowsArbitraryLoadsInWebContent',
  'NSAllowsLocalNetworking',
  'NSExceptionDomains',
]);

function resolvePrivacyProfile(config) {
  const profile = config.extra?.releaseManifest?.profile;
  if (!['development', 'preview', 'production'].includes(profile)) {
    throw new Error(`[M10-05] Cannot resolve privacy profile from extra.releaseManifest.profile`);
  }
  return profile;
}

function applyAndroidPrivacyManifest(androidManifest, { usesCleartextTraffic }) {
  if (typeof usesCleartextTraffic !== 'boolean') {
    throw new Error('[M10-05] android.usesCleartextTraffic must be profile-resolved');
  }

  const mainApplication = AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  mainApplication.$['android:allowBackup'] = 'false';
  mainApplication.$['android:fullBackupContent'] = `@xml/${FULL_BACKUP_RULES_RESOURCE}`;
  mainApplication.$['android:dataExtractionRules'] = `@xml/${DATA_EXTRACTION_RULES_RESOURCE}`;
  mainApplication.$['android:usesCleartextTraffic'] = String(usesCleartextTraffic);
  if (!usesCleartextTraffic) {
    delete mainApplication.$['android:networkSecurityConfig'];
  }

  if (mainApplication.service) {
    mainApplication.service = mainApplication.service.filter(
      (service) => !FORBIDDEN_BACKGROUND_SERVICES.has(service.$?.['android:name']),
    );
    if (mainApplication.service.length === 0) delete mainApplication.service;
  }

  const existingPermissions = androidManifest.manifest['uses-permission'] ?? [];
  androidManifest.manifest['uses-permission'] = existingPermissions.filter(
    (entry) => !BLOCKED_ANDROID_PERMISSIONS.includes(entry.$?.['android:name']),
  );
  for (const permission of BLOCKED_ANDROID_PERMISSIONS) {
    androidManifest.manifest['uses-permission'].push({
      $: {
        'android:name': permission,
        'tools:node': 'remove',
      },
    });
  }
  androidManifest.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
  return androidManifest;
}

function applyIosPrivacyInfoPlist(infoPlist, profile) {
  for (const key of IOS_LOCATION_USAGE_KEYS) delete infoPlist[key];
  // M30-02 local app lock uses Face ID through expo-local-authentication.
  // Tokens remain in SecureStore without requireAuthentication; this purpose is UI unlock only.
  if (infoPlist.NSFaceIDUsageDescription !==
      '用于在您明确开启应用锁后，以 Face ID 解锁本机上的 Agent SaaS 界面') {
    throw new Error('[M30-02] missing or inaccurate NSFaceIDUsageDescription');
  }

  if (Array.isArray(infoPlist.UIBackgroundModes)) {
    infoPlist.UIBackgroundModes = infoPlist.UIBackgroundModes.filter((mode) => mode !== 'audio');
    if (infoPlist.UIBackgroundModes.length === 0) delete infoPlist.UIBackgroundModes;
  }
  if (Array.isArray(infoPlist.LSApplicationQueriesSchemes)) {
    infoPlist.LSApplicationQueriesSchemes = infoPlist.LSApplicationQueriesSchemes.filter(
      (scheme) => scheme !== 'iosamap',
    );
    if (infoPlist.LSApplicationQueriesSchemes.length === 0) {
      delete infoPlist.LSApplicationQueriesSchemes;
    }
  }

  if (profile === 'production') {
    delete infoPlist.NSLocalNetworkUsageDescription;
    delete infoPlist.NSBonjourServices;
    const ats = infoPlist.NSAppTransportSecurity;
    if (ats && typeof ats === 'object' && !Array.isArray(ats)) {
      for (const key of IOS_PRODUCTION_ATS_EXCEPTION_KEYS) delete ats[key];
      if (Object.keys(ats).length === 0) delete infoPlist.NSAppTransportSecurity;
    }
  }
  return infoPlist;
}

async function writeAndroidBackupRules(platformProjectRoot) {
  const xmlDirectory = join(platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
  await mkdir(xmlDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(xmlDirectory, `${FULL_BACKUP_RULES_RESOURCE}.xml`), FULL_BACKUP_RULES),
    writeFile(join(xmlDirectory, `${DATA_EXTRACTION_RULES_RESOURCE}.xml`), DATA_EXTRACTION_RULES),
  ]);
}

function withMobilePrivacyControls(config) {
  const profile = resolvePrivacyProfile(config);
  const usesCleartextTraffic = config.android?.usesCleartextTraffic;
  if (config.android?.allowBackup !== false) {
    throw new Error('[M10-05] android.allowBackup must remain false');
  }

  config = withAndroidManifest(config, (androidConfig) => {
    androidConfig.modResults = applyAndroidPrivacyManifest(androidConfig.modResults, {
      usesCleartextTraffic,
    });
    return androidConfig;
  });

  config = withDangerousMod(config, [
    'android',
    async (androidConfig) => {
      await writeAndroidBackupRules(androidConfig.modRequest.platformProjectRoot);
      return androidConfig;
    },
  ]);

  config = withInfoPlist(config, (iosConfig) => {
    iosConfig.modResults = applyIosPrivacyInfoPlist(iosConfig.modResults, profile);
    return iosConfig;
  });

  return config;
}

module.exports = withMobilePrivacyControls;
module.exports.ANDROID_BACKUP_DOMAINS = ANDROID_BACKUP_DOMAINS;
module.exports.BLOCKED_ANDROID_PERMISSIONS = BLOCKED_ANDROID_PERMISSIONS;
module.exports.DATA_EXTRACTION_RULES = DATA_EXTRACTION_RULES;
module.exports.DATA_EXTRACTION_RULES_RESOURCE = DATA_EXTRACTION_RULES_RESOURCE;
module.exports.FORBIDDEN_BACKGROUND_SERVICES = FORBIDDEN_BACKGROUND_SERVICES;
module.exports.FULL_BACKUP_RULES = FULL_BACKUP_RULES;
module.exports.FULL_BACKUP_RULES_RESOURCE = FULL_BACKUP_RULES_RESOURCE;
module.exports.IOS_LOCATION_USAGE_KEYS = IOS_LOCATION_USAGE_KEYS;
module.exports.IOS_PRODUCTION_ATS_EXCEPTION_KEYS = IOS_PRODUCTION_ATS_EXCEPTION_KEYS;
module.exports.applyAndroidPrivacyManifest = applyAndroidPrivacyManifest;
module.exports.applyIosPrivacyInfoPlist = applyIosPrivacyInfoPlist;
module.exports.resolvePrivacyProfile = resolvePrivacyProfile;
module.exports.writeAndroidBackupRules = writeAndroidBackupRules;
