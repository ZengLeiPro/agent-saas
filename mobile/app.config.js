'use strict';

const staticExpoConfig = require('./app.json').expo;
const mobileEasConfig = require('./eas.json');
const {
  assertEasVersionPolicy,
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
  incomingSharePluginOptions(process.env);
  assertStaticExpoConfigHasNoReleaseFields(staticExpoConfig);
  assertEasVersionPolicy(mobileEasConfig, 'mobile/eas.json', { requireProfiles: true });
} catch (error) {
  reportAndRethrow(error);
}

module.exports = ({ config }) => {
  try {
    return applyIncomingShareConfig(
      createExpoConfig(config, { environment: process.env }),
      process.env,
    );
  } catch (error) {
    return reportAndRethrow(error);
  }
};
