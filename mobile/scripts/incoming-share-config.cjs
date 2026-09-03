'use strict';

const IOS_GROUP_PATTERN = /^group\.[A-Za-z0-9][A-Za-z0-9.-]+$/;
const TEAM_PATTERN = /^[A-Z0-9]{10}$/;

function isProduction(environment) {
  return environment.MOBILE_RELEASE_PROFILE === 'production'
    || environment.EAS_BUILD_PROFILE === 'production'
    || environment.EAS_BUILD_PROFILE === 'production-appstore'
    || environment.EAS_BUILD_PROFILE === 'production-internal';
}

function incomingSharePluginOptions(environment = {}, identity = {}) {
  const appleTeamId = String(
    environment.MOBILE_IOS_APPLE_TEAM_ID || identity.iosAppleTeamId || '',
  ).trim();
  const appGroup = String(
    environment.MOBILE_IOS_SHARE_APP_GROUP || identity.iosAppGroupIdentifier || '',
  ).trim();
  const configured = TEAM_PATTERN.test(appleTeamId) && IOS_GROUP_PATTERN.test(appGroup);
  if (isProduction(environment) && !configured) {
    throw new Error('M50-01 production iOS prebuild requires MOBILE_IOS_APPLE_TEAM_ID and MOBILE_IOS_SHARE_APP_GROUP; values are never guessed');
  }
  return {
    appleTeamId: configured ? appleTeamId : undefined,
    appGroupIdentifier: configured ? appGroup : undefined,
    plugin: ['expo-share-intent', {
      disableIOS: !configured,
      iosShareExtensionName: 'AgentSaaSShare',
      ...(configured ? { iosAppGroupIdentifier: appGroup } : {}),
      iosActivationRules: {
        NSExtensionActivationSupportsText: true,
        NSExtensionActivationSupportsImageWithMaxCount: 5,
        NSExtensionActivationSupportsFileWithMaxCount: 5,
      },
      androidIntentFilters: ['text/plain', 'image/*', 'application/pdf'],
      androidMultiIntentFilters: ['image/*', 'application/pdf'],
    }],
  };
}

function applyIncomingShareConfig(config, environment = {}, identity = {}) {
  const resolved = incomingSharePluginOptions(environment, identity);
  return {
    ...config,
    ios: {
      ...config.ios,
      ...(resolved.appleTeamId ? { appleTeamId: resolved.appleTeamId } : {}),
      ...(resolved.appGroupIdentifier
        ? {
            entitlements: {
              ...(config.ios?.entitlements || {}),
              'keychain-access-groups': [
                `$(AppIdentifierPrefix)${resolved.appGroupIdentifier}`,
              ],
            },
          }
        : {}),
    },
    plugins: [...(config.plugins || []), resolved.plugin],
  };
}

module.exports = { applyIncomingShareConfig, incomingSharePluginOptions, isProduction };
