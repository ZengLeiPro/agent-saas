'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IPHONE_ORIENTATIONS, IPAD_ORIENTATIONS } = require('./withIpadOrientation');

test('iPhone stays portrait-only; iPad allows landscape', () => {
  assert.deepEqual([...IPHONE_ORIENTATIONS], ['UIInterfaceOrientationPortrait']);
  assert.ok(IPAD_ORIENTATIONS.includes('UIInterfaceOrientationLandscapeLeft'));
  assert.ok(IPAD_ORIENTATIONS.includes('UIInterfaceOrientationLandscapeRight'));
  assert.equal(IPAD_ORIENTATIONS.length, 4);
});
