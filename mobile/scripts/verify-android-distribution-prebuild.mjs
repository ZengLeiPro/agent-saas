#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { verifyGeneratedAndroidSigningConfig } = require('../plugins/withAndroidSigningConfig');
const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = resolve(MOBILE_ROOT, 'android/app/src/main/AndroidManifest.xml');
const GRADLE_PATH = resolve(MOBILE_ROOT, 'android/app/build.gradle');
const INSTALL_PERMISSION = 'android.permission.REQUEST_INSTALL_PACKAGES';

function parseArguments(argv) {
  let distribution;
  let updater = 'disabled';
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--distribution' || argument === '--updater') {
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      if (argument === '--distribution') distribution = value;
      else updater = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  if (!['store', 'enterprise'].includes(distribution)) {
    throw new Error('--distribution must be store or enterprise');
  }
  if (!['enabled', 'disabled'].includes(updater)) {
    throw new Error('--updater must be enabled or disabled');
  }
  return { distribution, updater };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = readFileSync(MANIFEST_PATH, 'utf8');
  const gradle = readFileSync(GRADLE_PATH, 'utf8');
  const permissionCount = manifest.split(INSTALL_PERMISSION).length - 1;
  const expectedPermission = options.distribution === 'enterprise' && options.updater === 'enabled';
  if (expectedPermission && permissionCount !== 1) {
    throw new Error('Enterprise updater prebuild must contain exactly one install permission');
  }
  if (!expectedPermission && permissionCount !== 0) {
    throw new Error(`${options.distribution} prebuild must not contain install permission`);
  }
  verifyGeneratedAndroidSigningConfig(gradle);
  console.log(
    `M10-04 ${options.distribution} clean prebuild verified (updater=${options.updater}, installPermission=${permissionCount}, releaseSigner=external)`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[M10-04] Android distribution prebuild verification failed: ${message}`);
  process.exitCode = 1;
}
