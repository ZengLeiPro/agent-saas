/**
 * Expo config plugin: 注入 REQUEST_INSTALL_PACKAGES 权限
 *
 * Expo prebuild 的权限白名单不包含此权限，导致 app.json 中声明了也不会写入 AndroidManifest.xml。
 * 此 plugin 直接操作 manifest，确保 APK 自更新安装器能正常工作。
 */
const { withAndroidManifest } = require('expo/config-plugins');

function withInstallPermission(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const permissions = manifest['uses-permission'] || [];

    const permName = 'android.permission.REQUEST_INSTALL_PACKAGES';
    const exists = permissions.some(
      (p) => p.$?.['android:name'] === permName
    );

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
