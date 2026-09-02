#!/usr/bin/env node

import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const {
  RELEASE_MANIFEST_PATH,
  REPOSITORY_ROOT,
  assertProductionReady,
  readJson,
  resolveBuildContext,
  validateManifestSchema,
} = require('./release-manifest.cjs');
const {
  assertPublicKeyMatches,
  createEnterpriseUpdateManifest,
  loadExternalEd25519PrivateKey,
  sha256File,
  verifyEnterpriseUpdateManifestSignature,
  writeImmutableManifest,
} = require('./enterprise-update-manifest.cjs');

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!['--apk', '--artifact-url', '--output', '--git-sha'].includes(argument)) {
      throw new Error(`unknown argument ${argument}`);
    }
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    options[argument.slice(2).replaceAll('-', '')] = value;
    index += 1;
  }
  for (const name of ['apk', 'artifacturl', 'output', 'gitsha']) {
    if (!options[name])
      throw new Error(
        `--${name.replace('artifacturl', 'artifact-url').replace('gitsha', 'git-sha')} is required`,
      );
  }
  return options;
}

function loadExternalPrivateKey() {
  const suppliedPath = process.env.ENTERPRISE_UPDATE_SIGNING_PRIVATE_KEY_PATH;
  if (!suppliedPath || !isAbsolute(suppliedPath)) {
    throw new Error('ENTERPRISE_UPDATE_SIGNING_PRIVATE_KEY_PATH must be an absolute external path');
  }
  const realPath = realpathSync(suppliedPath);
  const relativeToRepository = relative(REPOSITORY_ROOT, realPath);
  if (!relativeToRepository.startsWith('..') && !isAbsolute(relativeToRepository)) {
    throw new Error('Enterprise update signing private key must remain outside the repository');
  }
  const stat = statSync(realPath);
  if (!stat.isFile()) throw new Error('Enterprise update signing key path is not a regular file');
  return loadExternalEd25519PrivateKey(
    readFileSync(realPath),
    process.env.ENTERPRISE_UPDATE_SIGNING_KEY_PASSPHRASE,
  );
}

function runApkAnalyzer(analyzer, apkPath, field) {
  const result = spawnSync(analyzer, ['manifest', field, apkPath], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to inspect APK ${field} with apkanalyzer`);
  }
  const value = result.stdout.trim();
  if (!value) throw new Error(`apkanalyzer returned an empty ${field}`);
  return value;
}

function assertApkIdentity(apkPath, manifest) {
  const defaultAnalyzer = process.env.ANDROID_HOME
    ? join(process.env.ANDROID_HOME, 'cmdline-tools/latest/bin/apkanalyzer')
    : '';
  const analyzer = process.env.ANDROID_APK_ANALYZER_PATH || defaultAnalyzer;
  if (!analyzer || !isAbsolute(analyzer) || !existsSync(analyzer)) {
    throw new Error(
      'ANDROID_APK_ANALYZER_PATH must identify apkanalyzer when the default Android SDK path is unavailable',
    );
  }
  const actualPackage = runApkAnalyzer(analyzer, apkPath, 'application-id');
  const actualVersionCode = runApkAnalyzer(analyzer, apkPath, 'version-code');
  const actualMarketingVersion = runApkAnalyzer(analyzer, apkPath, 'version-name');
  if (actualPackage !== manifest.identity.androidPackage) {
    throw new Error(`APK package mismatch (expected ${manifest.identity.androidPackage})`);
  }
  if (actualVersionCode !== String(manifest.version.androidVersionCode)) {
    throw new Error('APK versionCode does not match the verified release manifest');
  }
  if (actualMarketingVersion !== manifest.version.marketingVersion) {
    throw new Error('APK marketingVersion does not match the verified release manifest');
  }
}

function assertImmutableArtifactUrl(value, versionCode, gitSha, sha256) {
  const url = new URL(value);
  const versionSegment = `/${versionCode}/`;
  if (!url.pathname.includes(versionSegment) || !url.pathname.includes(gitSha)) {
    throw new Error(
      `artifact URL must include immutable versionCode and Git SHA path components (${versionCode}, ${gitSha})`,
    );
  }
  if (!url.pathname.includes(sha256)) {
    throw new Error('artifact URL must include the APK SHA-256 to prevent mutable object reuse');
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifest = validateManifestSchema(readJson(RELEASE_MANIFEST_PATH));
  const context = resolveBuildContext({
    environment: process.env,
    explicitProfile: 'production',
    explicitPlatform: 'android',
    explicitDistribution: 'enterprise',
    explicitGitSha: options.gitsha,
  });
  assertProductionReady(manifest, context);
  if (!context.enterpriseUpdater.enabled) {
    throw new Error('Enterprise updater build flag and verification configuration are required');
  }

  const apkPath = resolve(process.cwd(), options.apk);
  const apkStat = statSync(apkPath);
  if (!apkStat.isFile() || apkStat.size <= 0) throw new Error('APK path is not a non-empty file');
  assertApkIdentity(apkPath, manifest);
  const sha256 = sha256File(apkPath);
  assertImmutableArtifactUrl(
    options.artifacturl,
    manifest.version.androidVersionCode,
    options.gitsha,
    sha256,
  );

  const privateKey = loadExternalPrivateKey();
  assertPublicKeyMatches(privateKey, context.enterpriseUpdater.publicKey);
  const updateManifest = createEnterpriseUpdateManifest(
    {
      versionCode: manifest.version.androidVersionCode,
      marketingVersion: manifest.version.marketingVersion,
      package: manifest.identity.androidPackage,
      artifactUrl: options.artifacturl,
      sha256,
      size: apkStat.size,
      gitSha: options.gitsha,
      keyId: context.enterpriseUpdater.keyId,
    },
    privateKey,
  );
  verifyEnterpriseUpdateManifestSignature(updateManifest, createPublicKey(privateKey));

  const outputPath = resolve(process.cwd(), options.output);
  writeImmutableManifest(outputPath, updateManifest);
  console.log(
    `M10-04 immutable Enterprise update manifest created: ${outputPath} (versionCode=${updateManifest.versionCode}, sha256=${updateManifest.sha256})`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = message.startsWith('[M10-04]') ? '' : '[M10-04] ';
  console.error(`M10-04 Enterprise manifest preparation failed: ${prefix}${message}`);
  process.exitCode = 1;
}
