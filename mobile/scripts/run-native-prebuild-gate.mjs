#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkNativeTree, humanSummary, MOBILE_ROOT, PROFILES, updateGolden } from './native-policy-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HERE, '../..');
const EXPO_CLI = join(REPOSITORY_ROOT, 'node_modules/expo/bin/cli');
const TEST_TEAM_ID = 'TESTTEAM01';
const TEST_APP_GROUP = 'group.test-fixture.com.agentsaas.mobile';
const TEST_PUBLIC_KEY = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';

function parseArguments(argv) {
  const options = { profiles: [...PROFILES], updateGolden: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--update-golden') { options.updateGolden = true; continue; }
    if (argument !== '--profile') throw new Error(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error('--profile requires ios, store, enterprise, or all');
    options.profiles = value === 'all' ? [...PROFILES] : [value];
    index += 1;
  }
  for (const profile of options.profiles) {
    if (!PROFILES.includes(profile)) throw new Error(`unsupported profile ${profile}`);
  }
  if (options.updateGolden && process.env.M60_03_UPDATE_GOLDEN !== '1') {
    throw new Error('--update-golden requires M60_03_UPDATE_GOLDEN=1');
  }
  return options;
}

function writeFixtureManifest(path, distribution) {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.version.iosBuildNumber = Math.max(2, manifest.version.iosBuildNumber);
  manifest.version.androidVersionCode = Math.max(86, (manifest.version.latestPublished.androidVersionCode ?? 0) + 1);
  manifest.version.latestPublished = {
    marketingVersion: '0.9.4-m60-03-test-fixture',
    iosBuildNumber: manifest.version.iosBuildNumber - 1,
    androidVersionCode: manifest.version.androidVersionCode - 1,
  };
  manifest.target = {
    profile: 'production',
    distribution,
    gitSha: '0000000000000000000000000000000000000000',
  };
  manifest.verification = { identity: 'verified', versions: 'verified', distribution: 'verified' };
  manifest.oauthCallback.enabled.production = true;
  manifest.oauthCallback.profiles.production = ['https://mobile.example.test/oauth/callback'];
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function makeTempMobile() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'm60-03-native-'));
  const temporaryMobile = join(temporaryRoot, 'mobile');
  cpSync(MOBILE_ROOT, temporaryMobile, {
    recursive: true,
    dereference: false,
    filter(source) {
      const relative = source.slice(MOBILE_ROOT.length).replace(/^[/\\]/, '').split(/[/\\]/)[0];
      return !['android', 'ios', 'node_modules', '.expo'].includes(relative);
    },
  });
  symlinkSync(join(REPOSITORY_ROOT, 'node_modules'), join(temporaryMobile, 'node_modules'), 'dir');
  return { temporaryRoot, temporaryMobile };
}

function environmentFor(profile) {
  const distribution = profile === 'enterprise' ? 'enterprise' : 'store';
  const environment = {
    ...process.env,
    CI: '1',
    EXPO_PUBLIC_V1_PROFILE: 'production',
    MOBILE_BUILD_PLATFORM: profile === 'ios' ? 'ios' : 'android',
    MOBILE_ANDROID_DISTRIBUTION: distribution,
    MOBILE_SOURCE_GIT_SHA: '0000000000000000000000000000000000000000',
  };
  // The fixture SHA is authoritative inside this isolated generation. Ambient
  // CI/build identities belong to the checked-out repository, not this fixture.
  delete environment.GITHUB_SHA;
  delete environment.EAS_BUILD_GIT_COMMIT_HASH;
  // Explicit, unmistakable fixture identities permit native generation without
  // guessing a real Apple team, app group, provisioning profile, or signer.
  if (profile === 'ios') {
    environment.MOBILE_RELEASE_PROFILE = 'production';
    environment.MOBILE_IOS_APPLE_TEAM_ID = TEST_TEAM_ID;
    environment.MOBILE_IOS_SHARE_APP_GROUP = TEST_APP_GROUP;
  }
  if (profile === 'enterprise') {
    environment.MOBILE_ENTERPRISE_UPDATER_ENABLED = 'true';
    environment.MOBILE_ENTERPRISE_UPDATE_MANIFEST_URL = 'https://updates.example.test/android/enterprise/latest.json';
    environment.MOBILE_ENTERPRISE_UPDATE_PUBLIC_KEY = TEST_PUBLIC_KEY;
    environment.MOBILE_ENTERPRISE_UPDATE_KEY_ID = 'm60-03-test-fixture';
  }
  return environment;
}

function runProfile(profile, options, artifactDirectory) {
  const { temporaryRoot, temporaryMobile } = makeTempMobile();
  try {
    const distribution = profile === 'enterprise' ? 'enterprise' : 'store';
    writeFixtureManifest(join(temporaryMobile, 'release-manifest.json'), distribution);
    const platform = profile === 'ios' ? 'ios' : 'android';
    const prebuild = spawnSync(process.execPath, [EXPO_CLI, 'prebuild', '--clean', '--no-install', '--platform', platform], {
      cwd: temporaryMobile,
      env: environmentFor(profile),
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    if (prebuild.status !== 0) {
      const bounded = `${prebuild.stdout ?? ''}\n${prebuild.stderr ?? ''}`
        .replaceAll(temporaryRoot, '<generated-root>')
        .replaceAll(REPOSITORY_ROOT, '<workspace>')
        .split('\n')
        .slice(-120)
        .join('\n');
      throw new Error(`${profile} clean prebuild failed (exit ${prebuild.status}):\n${bounded}`);
    }
    // The dependency link exists only to execute Expo in the isolated copy. It
    // is removed before the checker receives the actual generated tree.
    rmSync(join(temporaryMobile, 'node_modules'), { force: true });
    const jsonPath = join(artifactDirectory, `${profile}.normalized.json`);
    const result = checkNativeTree({
      root: temporaryMobile,
      profile,
      compareGolden: options.updateGolden ? false : true,
      jsonPath,
      // 三个 profile 的原生树都由 EXPO_PUBLIC_V1_PROFILE=production 生成（见 environmentFor）。
      releaseProfile: 'production',
      evidence: { classification: 'test-fixture', teamId: TEST_TEAM_ID, appGroup: TEST_APP_GROUP },
    });
    if (options.updateGolden) {
      updateGolden(profile, result.normalized);
      const verified = checkNativeTree({
        root: temporaryMobile,
        profile,
        compareGolden: true,
        jsonPath,
        releaseProfile: 'production',
        evidence: { classification: 'test-fixture', teamId: TEST_TEAM_ID, appGroup: TEST_APP_GROUP },
      });
      process.stdout.write(`${humanSummary(verified)}\n`);
      if (!verified.ok) throw new Error(`${profile} updated golden did not verify`);
      return verified;
    }
    process.stdout.write(`${humanSummary(result)}\n`);
    if (!result.ok) throw new Error(`${profile} native policy failed`);
    return result;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const artifactDirectory = resolve(process.env.M60_03_ARTIFACT_DIR || mkdtempSync(join(tmpdir(), 'm60-03-results-')));
  mkdirSync(artifactDirectory, { recursive: true });
  const results = options.profiles.map((profile) => runProfile(profile, options, artifactDirectory));
  // All profile runs use the explicit test fixture evidence classification.
  const summary = {
    schemaVersion: 1,
    ok: results.every((result) => result.ok),
    profiles: results.map((result) => ({
      correlationId: result.correlationId,
      evidence: result.evidence,
      normalizedSha256: result.summary.normalizedSha256,
      profile: result.profile,
    })),
  };
  writeFileSync(join(artifactDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`M60-03 clean prebuild gate passed (${options.profiles.join(', ')}); results=<artifact-dir>\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`M60-03 clean prebuild gate failed: ${message}\n`);
  process.exitCode = 1;
}
