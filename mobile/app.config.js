'use strict';

const staticExpoConfig = require('./app.json').expo;
const mobileEasConfig = require('./eas.json');
const releaseManifest = require('./release-manifest.json');
const {
  assertEasVersionPolicy,
  assertProductionBuildEnvironment,
  assertStaticExpoConfigHasNoReleaseFields,
  createExpoConfig,
} = require('./scripts/release-manifest.cjs');
const { applyIncomingShareConfig, incomingSharePluginOptions } = require('./scripts/incoming-share-config.cjs');

function reportAndRethrow(error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  throw error;
}

try {
  incomingSharePluginOptions(process.env, releaseManifest.identity);
  assertStaticExpoConfigHasNoReleaseFields(staticExpoConfig);
  assertEasVersionPolicy(mobileEasConfig, 'mobile/eas.json', { requireProfiles: true });
  assertProductionBuildEnvironment(mobileEasConfig, releaseManifest);
} catch (error) {
  reportAndRethrow(error);
}

module.exports = ({ config }) => {
  try {
    return applyIncomingShareConfig(
      createExpoConfig(config, { environment: process.env }),
      process.env,
      releaseManifest.identity,
    );
  } catch (error) {
    return reportAndRethrow(error);
  }
};
