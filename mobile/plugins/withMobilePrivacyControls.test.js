const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { describe, it } = require('node:test');
const {
  ANDROID_BACKUP_DOMAINS,
  BLOCKED_ANDROID_PERMISSIONS,
  DATA_EXTRACTION_RULES,
  DATA_EXTRACTION_RULES_RESOURCE,
  FULL_BACKUP_RULES,
  FULL_BACKUP_RULES_RESOURCE,
  applyAndroidPrivacyManifest,
  applyIosPrivacyInfoPlist,
  resolvePrivacyProfile,
  writeAndroidBackupRules,
} = require('./withMobilePrivacyControls');

function androidFixture() {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      'uses-permission': [
        { $: { 'android:name': 'android.permission.INTERNET' } },
        { $: { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' } },
        { $: { 'android:name': 'android.permission.SYSTEM_ALERT_WINDOW' } },
      ],
      application: [
        {
          $: {
            'android:name': '.MainApplication',
            'android:allowBackup': 'true',
            'android:usesCleartextTraffic': 'true',
            'android:networkSecurityConfig': '@xml/insecure_network',
          },
          service: [
            {
              $: {
                'android:name': 'expo.modules.audio.service.AudioControlsService',
                'android:foregroundServiceType': 'mediaPlayback',
              },
            },
          ],
        },
      ],
    },
  };
}

describe('M10-05 mobile privacy config plugin', () => {
  it('forces production cleartext and Android backup fail closed', () => {
    const manifest = applyAndroidPrivacyManifest(androidFixture(), {
      usesCleartextTraffic: false,
    });
    const app = manifest.manifest.application[0];
    assert.equal(app.$['android:allowBackup'], 'false');
    assert.equal(app.$['android:usesCleartextTraffic'], 'false');
    assert.equal(app.$['android:networkSecurityConfig'], undefined);
    assert.equal(app.$['android:fullBackupContent'], `@xml/${FULL_BACKUP_RULES_RESOURCE}`);
    assert.equal(app.$['android:dataExtractionRules'], `@xml/${DATA_EXTRACTION_RULES_RESOURCE}`);
    assert.equal(app.service, undefined);

    const permissions = manifest.manifest['uses-permission'];
    assert.equal(
      permissions.filter((entry) => entry.$['android:name'] === 'android.permission.INTERNET')
        .length,
      1,
    );
    for (const permission of BLOCKED_ANDROID_PERMISSIONS) {
      const entries = permissions.filter((entry) => entry.$['android:name'] === permission);
      assert.equal(entries.length, 1, `${permission} must have one removal marker`);
      assert.equal(entries[0].$['tools:node'], 'remove');
    }
  });

  it('writes deny-all rules for legacy, cloud, and device-transfer backup paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'm10-05-backup-'));
    try {
      await writeAndroidBackupRules(root);
      const xmlRoot = join(root, 'app', 'src', 'main', 'res', 'xml');
      const [legacy, extraction] = await Promise.all([
        readFile(join(xmlRoot, `${FULL_BACKUP_RULES_RESOURCE}.xml`), 'utf8'),
        readFile(join(xmlRoot, `${DATA_EXTRACTION_RULES_RESOURCE}.xml`), 'utf8'),
      ]);
      assert.equal(legacy, FULL_BACKUP_RULES);
      assert.equal(extraction, DATA_EXTRACTION_RULES);
      assert.match(extraction, /<cloud-backup>/);
      assert.match(extraction, /<device-transfer>/);
      for (const domain of ANDROID_BACKUP_DOMAINS) {
        assert.match(legacy, new RegExp(`<exclude domain="${domain}" path="\\." \\/>`));
        assert.equal(extraction.split(`domain="${domain}"`).length - 1, 2);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('strips location, Face ID, and background audio in every profile', () => {
    const plist = applyIosPrivacyInfoPlist(
      {
        NSLocationWhenInUseUsageDescription: 'fixture',
        NSLocationAlwaysUsageDescription: 'fixture',
        NSFaceIDUsageDescription: 'fixture',
        UIBackgroundModes: ['audio'],
        LSApplicationQueriesSchemes: ['iosamap'],
      },
      'preview',
    );
    assert.equal(plist.NSLocationWhenInUseUsageDescription, undefined);
    assert.equal(plist.NSLocationAlwaysUsageDescription, undefined);
    assert.equal(plist.NSFaceIDUsageDescription, undefined);
    assert.equal(plist.UIBackgroundModes, undefined);
    assert.equal(plist.LSApplicationQueriesSchemes, undefined);
  });

  it('keeps development local-network behavior profile-scoped and removes it in production', () => {
    const makePlist = () => ({
      NSLocalNetworkUsageDescription: 'fixture',
      NSBonjourServices: ['_fixture._tcp'],
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: false,
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: { 'fixture.local': {} },
      },
    });
    const preview = applyIosPrivacyInfoPlist(makePlist(), 'preview');
    assert.equal(preview.NSAppTransportSecurity.NSAllowsLocalNetworking, true);

    const production = applyIosPrivacyInfoPlist(makePlist(), 'production');
    assert.equal(production.NSLocalNetworkUsageDescription, undefined);
    assert.equal(production.NSBonjourServices, undefined);
    assert.equal(production.NSAppTransportSecurity, undefined);
  });

  it('refuses to run without the release profile token', () => {
    assert.equal(
      resolvePrivacyProfile({ extra: { releaseManifest: { profile: 'production' } } }),
      'production',
    );
    assert.throws(() => resolvePrivacyProfile({ extra: {} }), /Cannot resolve privacy profile/);
  });
});
