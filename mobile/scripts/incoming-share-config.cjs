'use strict';

const IOS_GROUP_PATTERN = /^group\.[A-Za-z0-9][A-Za-z0-9.-]+$/;
const TEAM_PATTERN = /^[A-Z0-9]{10}$/;

function isProduction(environment) {
  return environment.MOBILE_RELEASE_PROFILE === 'production'
    || environment.EAS_BUILD_PROFILE === 'production'
    || environment.EAS_BUILD_PROFILE === 'production-appstore'
    || environment.EAS_BUILD_PROFILE === 'production-internal';
}

function incomingSharePluginOptions(environment = {}) {
  const appleTeamId = String(environment.MOBILE_IOS_APPLE_TEAM_ID || '').trim();
  const appGroup = String(environment.MOBILE_IOS_SHARE_APP_GROUP || '').trim();
  const configured = TEAM_PATTERN.test(appleTeamId) && IOS_GROUP_PATTERN.test(appGroup);
  if (isProduction(environment) && !configured) {
    throw new Error('M50-01 production iOS prebuild requires MOBILE_IOS_APPLE_TEAM_ID and MOBILE_IOS_SHARE_APP_GROUP; values are never guessed');
  }
  return {
    appleTeamId: configured ? appleTeamId : undefined,
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

function applyIncomingShareConfig(config, environment = {}) {
  const resolved = incomingSharePluginOptions(environment);
  return {
    ...config,
    ios: {
      ...config.ios,
      ...(resolved.appleTeamId ? { appleTeamId: resolved.appleTeamId } : {}),
    },
    plugins: [...(config.plugins || []), resolved.plugin],
  };
}

module.exports = { applyIncomingShareConfig, incomingSharePluginOptions, isProduction };
