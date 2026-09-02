#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE_ROOT = resolve(HERE, '..');
const REPOSITORY_ROOT = resolve(MOBILE_ROOT, '..');
const require = createRequire(import.meta.url);
const { verifyGeneratedAndroidSigningConfig } = require('../plugins/withAndroidSigningConfig');

// SHA-256 of the compromised numeric release password formerly committed in
// withAndroidSigningConfig.js. The plaintext is deliberately not repeated.
const COMPROMISED_PASSWORD_SHA256 =
  'f6e5c74d9b838359cf047c7898c540166fc5aca50d36e9ff7bbeb7b09e9b6674';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function listTrackedFiles() {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    {
      cwd: REPOSITORY_ROOT,
      encoding: 'buffer',
    },
  );
  if (result.status !== 0) {
    throw new Error('Unable to enumerate tracked files for the M00-02 secret scan');
  }
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function verifyTrackedSource() {
  const trackedFiles = listTrackedFiles();
  const trackedCredentialFiles = trackedFiles.filter(
    (file) =>
      /^mobile\/(?:certs\/|credentials\.json$)/.test(file) ||
      /^mobile\/.*\.(?:jks|keystore)$/i.test(file),
  );
  if (trackedCredentialFiles.length > 0) {
    throw new Error(
      `Android credential files must not be tracked: ${trackedCredentialFiles.join(', ')}`,
    );
  }

  const leakedFiles = [];
  let scannedTextFiles = 0;
  for (const relativePath of trackedFiles) {
    const absolutePath = join(REPOSITORY_ROOT, relativePath);
    let stat;
    try {
      stat = statSync(absolutePath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) continue;

    const buffer = readFileSync(absolutePath);
    if (buffer.subarray(0, 8192).includes(0)) continue;
    const source = buffer.toString('utf8');
    scannedTextFiles += 1;
    const numericCandidates = source.match(/(?<!\d)\d{6}(?!\d)/g) ?? [];
    if (numericCandidates.some((candidate) => sha256(candidate) === COMPROMISED_PASSWORD_SHA256)) {
      leakedFiles.push(relativePath);
    }
  }

  if (leakedFiles.length > 0) {
    throw new Error(
      `Compromised Android release password remains in tracked source: ${leakedFiles.join(', ')}`,
    );
  }
  return { trackedFiles: trackedFiles.length, scannedTextFiles };
}

function verifyGeneratedGradle(gradlePath) {
  const contents = readFileSync(gradlePath, 'utf8');
  verifyGeneratedAndroidSigningConfig(contents);
}

function main() {
  const sourceResult = verifyTrackedSource();
  if (process.argv.includes('--source-only')) {
    console.log(
      `M00-02 source scan passed (${sourceResult.scannedTextFiles}/${sourceResult.trackedFiles} tracked files inspected)`,
    );
    return;
  }

  const positional = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  const gradlePath = positional
    ? resolve(process.cwd(), positional)
    : join(MOBILE_ROOT, 'android', 'app', 'build.gradle');
  verifyGeneratedGradle(gradlePath);
  console.log(
    `M00-02 Android signing checks passed (${sourceResult.scannedTextFiles}/${sourceResult.trackedFiles} tracked files inspected; generated Gradle verified)`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`M00-02 Android signing checks failed: ${message}`);
  process.exitCode = 1;
}
