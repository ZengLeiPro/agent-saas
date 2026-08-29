#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, '..');
const ANDROID_ROOT = join(MOBILE_ROOT, 'android');
const REQUIRED_SIGNING_ENV = [
  'ANDROID_RELEASE_KEYSTORE_PATH',
  'ANDROID_RELEASE_STORE_PASSWORD',
  'ANDROID_RELEASE_KEY_ALIAS',
  'ANDROID_RELEASE_KEY_PASSWORD',
];
const EXPECTED_FAILURE =
  'Android release signing is blocked: missing required environment variables:';

function redact(output, environment) {
  let redacted = output;
  for (const [name, value] of Object.entries(environment)) {
    if (!/(?:TOKEN|SECRET|PASSWORD|PRIVATE|CREDENTIAL|API_KEY)/i.test(name)) {
      continue;
    }
    if (!value || value.length < 4) continue;
    redacted = redacted.split(value).join(`<redacted:${name}>`);
  }
  return redacted.replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/g, 'https://<redacted>@');
}

function main() {
  const wrapper = join(ANDROID_ROOT, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (!existsSync(wrapper)) {
    throw new Error('generated Android Gradle wrapper is missing; run clean prebuild first');
  }

  const childEnvironment = { ...process.env };
  for (const name of REQUIRED_SIGNING_ENV) delete childEnvironment[name];
  childEnvironment.CI = '1';

  const result = spawnSync(
    wrapper,
    [':app:validateAndroidReleaseSigningCredentials', '--no-daemon', '--console=plain'],
    {
      cwd: ANDROID_ROOT,
      env: childEnvironment,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;

  const combinedOutput = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status === 0) {
    throw new Error('release credential validation unexpectedly succeeded without required inputs');
  }
  if (!combinedOutput.includes(EXPECTED_FAILURE)) {
    const safeTail = redact(combinedOutput, childEnvironment).split('\n').slice(-40).join('\n');
    throw new Error(
      `Gradle failed for an unrelated reason instead of the M00-02 gate:\n${safeTail}`,
    );
  }

  console.log(
    `M00-02 fail-closed Gradle check passed (expected non-zero exit ${result.status}; no signing inputs supplied)`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`M00-02 fail-closed Gradle check failed: ${message}`);
  process.exitCode = 1;
}
