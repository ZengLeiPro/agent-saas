/**
 * Expo config plugin: 自动注入 Android release 签名配置
 *
 * 确保 `expo prebuild --clean` 后 build.gradle 中始终包含
 * release keystore 签名配置，防止因签名丢失导致 APK 被识别为新应用。
 */
const { withAppBuildGradle } = require("expo/config-plugins");

const SIGNING_CONFIG_BLOCK = `
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        release {
            storeFile file("\${projectRoot}/certs/release.keystore")
            storePassword '050901'
            keyAlias 'agent-saas'
            keyPassword '050901'
        }
    }`;

function withAndroidSigningConfig(config) {
  return withAppBuildGradle(config, (config) => {
    let contents = config.modResults.contents;

    // 已有 release signingConfig 则跳过
    if (contents.includes("signingConfigs") && contents.includes("release {")) {
      return config;
    }

    // 注入 signingConfigs 到 android { 块内，buildTypes 之前
    contents = contents.replace(
      /(\s+)(buildTypes\s*\{)/,
      `$1${SIGNING_CONFIG_BLOCK}\n$1$2`,
    );

    // 确保 release buildType 使用 release signingConfig
    contents = contents.replace(
      /(buildTypes\s*\{[^}]*release\s*\{[^}]*)(signingConfig\s+signingConfigs\.\w+)/,
      "$1signingConfig signingConfigs.release",
    );

    // 如果 release buildType 里没有 signingConfig，加一个
    if (!/release\s*\{[^}]*signingConfig/.test(contents)) {
      contents = contents.replace(
        /(buildTypes\s*\{[^}]*)(release\s*\{)/,
        "$1$2\n            signingConfig signingConfigs.release",
      );
    }

    config.modResults.contents = contents;
    return config;
  });
}

module.exports = withAndroidSigningConfig;
