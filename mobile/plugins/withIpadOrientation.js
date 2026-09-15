'use strict';

/**
 * P0 iPad landscape: keep iPhone portrait-locked while allowing all iPad orientations.
 * Expo's top-level `orientation: "portrait"` can expand or overwrite Info.plist keys;
 * this plugin re-asserts the Apple-documented ~ipad key after other mods.
 */

const IPHONE_ORIENTATIONS = Object.freeze(['UIInterfaceOrientationPortrait']);

const IPAD_ORIENTATIONS = Object.freeze([
  'UIInterfaceOrientationPortrait',
  'UIInterfaceOrientationPortraitUpsideDown',
  'UIInterfaceOrientationLandscapeLeft',
  'UIInterfaceOrientationLandscapeRight',
]);

function withIpadOrientation(config) {
  const { withInfoPlist } = require('@expo/config-plugins');
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.UISupportedInterfaceOrientations = [...IPHONE_ORIENTATIONS];
    cfg.modResults['UISupportedInterfaceOrientations~ipad'] = [...IPAD_ORIENTATIONS];
    return cfg;
  });
}

module.exports = withIpadOrientation;
module.exports.IPHONE_ORIENTATIONS = IPHONE_ORIENTATIONS;
module.exports.IPAD_ORIENTATIONS = IPAD_ORIENTATIONS;
