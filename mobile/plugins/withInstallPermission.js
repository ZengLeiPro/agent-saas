/**
 * Enterprise-only Expo config plugin: inject REQUEST_INSTALL_PACKAGES.
 *
 * M10-04 registers this plugin dynamically only when the Enterprise updater's
 * controlled build flag and verification public key are both present. Store
 * and updater-disabled builds must never register it.
 */
const { withAndroidManifest } = require('expo/config-plugins');

function withInstallPermission(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const permissions = manifest['uses-permission'] || [];

    const permName = 'android.permission.REQUEST_INSTALL_PACKAGES';
    const exists = permissions.some((permission) => permission.$?.['android:name'] === permName);

    if (!exists) {
      permissions.push({
        $: { 'android:name': permName },
      });
      manifest['uses-permission'] = permissions;
    }

    return config;
  });
}

module.exports = withInstallPermission;
