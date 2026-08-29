import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  MOBILE_ROOT,
  RELEASE_MANIFEST_PATH,
  REPOSITORY_ROOT,
  assertExpoIdentityMatchesManifest,
  assertProductionReady,
  compareSemver,
  createArtifactIdentity,
  createExpoConfig,
  loadRepositoryInputs,
  readJson,
  resolveBuildContext,
  resolveRequestedProfile,
  validateManifestSchema,
  verifyRepositoryReleaseConfiguration,
} = require('./release-manifest.cjs');

const HERE = dirname(fileURLToPath(import.meta.url));
const FULL_GIT_SHA = '1234567890abcdef1234567890abcdef12345678';

function cloneManifest() {
  return structuredClone(readJson(RELEASE_MANIFEST_PATH));
}

function productionReadyManifest() {
  const manifest = cloneManifest();
  manifest.version.androidVersionCode = 86;
  manifest.version.latestPublished = {
    marketingVersion: '1.9.5',
    iosBuildNumber: 84,
    androidVersionCode: 85,
  };
  manifest.target = { profile: 'production', gitSha: FULL_GIT_SHA };
  manifest.verification = { identity: 'verified', versions: 'verified' };
  return manifest;
}

function cleanExpoEnvironment(profile) {
  const environment = { ...process.env, EXPO_PUBLIC_V1_PROFILE: profile };
  for (const name of [
    'MOBILE_RELEASE_PROFILE',
    'MOBILE_SOURCE_GIT_SHA',
    'EAS_BUILD_PROFILE',
    'EAS_BUILD_GIT_COMMIT_HASH',
    'GITHUB_SHA',
  ]) {
    delete environment[name];
  }
  return environment;
}

function runExpoConfig(cwd, profile) {
  return spawnSync('pnpm', ['exec', 'expo', 'config', '--type', 'public', '--json'], {
    cwd,
    env: cleanExpoEnvironment(profile),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function commandEvidence(result) {
  return `status=${result.status}\nstdout=${result.stdout ?? ''}\nstderr=${result.stderr ?? ''}`;
}

test('M10-03 manifest schema accepts the checked-in pending-external-verification record', () => {
  const manifest = cloneManifest();
  assert.equal(validateManifestSchema(manifest), manifest);
  assert.equal(manifest.verification.identity, 'pending-external-verification');
  assert.equal(manifest.verification.versions, 'pending-external-verification');
  assert.equal(manifest.version.androidVersionCode, null);
});

test('M10-03 manifest schema rejects missing and unexpected fields', () => {
  const missing = cloneManifest();
  delete missing.identity.scheme;
  assert.throws(() => validateManifestSchema(missing), /identity schema mismatch.*missing scheme/);

  const unexpected = cloneManifest();
  unexpected.version.remoteVersion = 99;
  assert.throws(
    () => validateManifestSchema(unexpected),
    /version schema mismatch.*unexpected remoteVersion/,
  );
});

test('M10-03 integer and SemVer fields fail closed', () => {
  const fractionalBuild = cloneManifest();
  fractionalBuild.version.iosBuildNumber = 85.5;
  assert.throws(() => validateManifestSchema(fractionalBuild), /positive safe integer/);

  const stringVersionCode = cloneManifest();
  stringVersionCode.version.androidVersionCode = '86';
  assert.throws(() => validateManifestSchema(stringVersionCode), /positive safe integer or null/);

  const malformedSemver = cloneManifest();
  malformedSemver.version.marketingVersion = '1.9';
  assert.throws(() => validateManifestSchema(malformedSemver), /valid SemVer/);

  assert.equal(compareSemver('1.9.5', '1.9.5'), 0);
  assert.equal(compareSemver('1.10.0', '1.9.5'), 1);
  assert.equal(compareSemver('2.0.0-beta.1', '2.0.0'), -1);
});

test('M10-03 monotonic release rules reject regressions and reused build integers', () => {
  const marketingRegression = productionReadyManifest();
  marketingRegression.version.latestPublished.marketingVersion = '1.9.6';
  assert.throws(() => validateManifestSchema(marketingRegression), /marketingVersion is lower/);

  const reusedIosBuild = productionReadyManifest();
  reusedIosBuild.version.latestPublished.iosBuildNumber = 85;
  assert.throws(() => validateManifestSchema(reusedIosBuild), /iosBuildNumber must be greater/);

  const reusedAndroidCode = productionReadyManifest();
  reusedAndroidCode.version.androidVersionCode = 85;
  assert.throws(
    () => validateManifestSchema(reusedAndroidCode),
    /androidVersionCode must be greater/,
  );
});

test('M10-03 production requires verified identity/version facts and all release target fields', () => {
  const manifest = cloneManifest();
  assert.throws(
    () =>
      assertProductionReady(manifest, {
        profile: 'production',
        sourceGitSha: FULL_GIT_SHA,
      }),
    (error) => {
      assert.match(error.message, /target\.profile is missing/);
      assert.match(error.message, /target\.gitSha is missing/);
      assert.match(error.message, /identity is pending external verification/);
      assert.match(error.message, /versions are pending external verification/);
      assert.match(error.message, /androidVersionCode is missing/);
      assert.match(error.message, /latestPublished\.androidVersionCode is missing/);
      return true;
    },
  );
});

test('M10-03 production target profile and Git SHA must match', () => {
  const manifest = productionReadyManifest();
  assert.doesNotThrow(() =>
    assertProductionReady(manifest, {
      profile: 'production',
      sourceGitSha: FULL_GIT_SHA,
    }),
  );

  const profileMismatch = productionReadyManifest();
  profileMismatch.target.profile = 'preview';
  assert.throws(
    () =>
      assertProductionReady(profileMismatch, {
        profile: 'production',
        sourceGitSha: FULL_GIT_SHA,
      }),
    /target\.profile mismatch/,
  );

  assert.throws(
    () =>
      assertProductionReady(manifest, {
        profile: 'production',
        sourceGitSha: 'abcdef1234567890abcdef1234567890abcdef12',
      }),
    /Git SHA mismatch/,
  );
});

test('M10-03 conflicting profile declarations fail closed', () => {
  assert.throws(
    () =>
      resolveRequestedProfile({
        EAS_BUILD_PROFILE: 'production',
        EXPO_PUBLIC_V1_PROFILE: 'preview',
      }),
    /release profile mismatch/,
  );
});

test('M10-03 development and preview configs generate without external store facts', () => {
  const { manifest, staticExpoConfig } = loadRepositoryInputs();
  for (const profile of ['development', 'preview']) {
    const context = { profile, sourceGitSha: FULL_GIT_SHA };
    const config = createExpoConfig(staticExpoConfig, { manifest, context });
    assert.doesNotThrow(() => assertExpoIdentityMatchesManifest(config, manifest, context));
    assert.equal(config.android.versionCode, undefined);
    assert.equal(config.extra.releaseManifest.profile, profile);
    assert.equal(config.extra.releaseManifest.version.androidVersionCode, 'not-set');
  }
});

test('M10-03 generated Expo identity rejects drift from the manifest', () => {
  const { manifest, staticExpoConfig } = loadRepositoryInputs();
  const context = { profile: 'preview', sourceGitSha: FULL_GIT_SHA };
  const config = createExpoConfig(staticExpoConfig, { manifest, context });
  config.ios.bundleIdentifier = 'invalid.example.bundle';
  assert.throws(
    () => assertExpoIdentityMatchesManifest(config, manifest, context),
    /Expo identity mismatch.*ios\.bundleIdentifier/s,
  );
});

test('M10-03 repository config consumes the manifest and keeps EAS versioning local', () => {
  const inputs = loadRepositoryInputs();
  const context = { profile: 'preview', sourceGitSha: FULL_GIT_SHA };
  const artifactIdentity = verifyRepositoryReleaseConfiguration({ ...inputs, context });
  assert.deepEqual(artifactIdentity, createArtifactIdentity(inputs.manifest, context));
  assert.equal(inputs.mobileEasConfig.cli.appVersionSource, 'local');
  assert.equal(inputs.rootEasConfig.cli.appVersionSource, 'local');
  assert.equal(inputs.mobileEasConfig.build.production.autoIncrement, undefined);
});

test('M10-03 repository-root Expo config fails with a clear mobile-only project-root error', () => {
  const result = runExpoConfig(REPOSITORY_ROOT, 'preview');
  assert.notEqual(result.status, 0, commandEvidence(result));
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.match(output, /\[M10-03\] Invalid Expo\/EAS project root/);
  assert.match(output, /mobile\/ is the only supported project root/);
});

test('M10-03 mobile public Expo config matches manifest identity and exposes artifact expectations', () => {
  const environment = cleanExpoEnvironment('preview');
  const result = runExpoConfig(MOBILE_ROOT, 'preview');
  assert.equal(result.status, 0, commandEvidence(result));
  const expoConfig = JSON.parse(result.stdout);
  const context = resolveBuildContext({ environment });
  const manifest = cloneManifest();
  assert.doesNotThrow(() => assertExpoIdentityMatchesManifest(expoConfig, manifest, context));
  assert.equal(
    expoConfig.extra.releaseManifest.identity.iosBundleIdentifier,
    manifest.identity.iosBundleIdentifier,
  );
  assert.equal(
    expoConfig.extra.releaseManifest.identity.androidPackage,
    manifest.identity.androidPackage,
  );
  assert.equal(expoConfig.extra.releaseManifest.version.androidVersionCode, 'not-set');
});

test('M10-03 production config is fail closed with the checked-in unverified manifest', () => {
  const { staticExpoConfig, manifest } = loadRepositoryInputs();
  assert.throws(
    () =>
      createExpoConfig(staticExpoConfig, {
        manifest,
        context: { profile: 'production', sourceGitSha: FULL_GIT_SHA },
      }),
    /Production release is blocked/,
  );
});

test('M10-03 production build script stops before EAS while external facts are unverified', () => {
  const result = spawnSync('bash', ['scripts/build.sh', 'ios', '--build'], {
    cwd: MOBILE_ROOT,
    env: cleanExpoEnvironment('production'),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.notEqual(result.status, 0, commandEvidence(result));
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.match(output, /Production release is blocked/);
  assert.match(output, /androidVersionCode is missing/);
  assert.match(output, /构建未启动/);
  assert.doesNotMatch(output, /开始 iOS 本地构建/);
});

test('M10-03 build script reads release version through the manifest verifier', () => {
  const buildScript = readFileSync(resolve(HERE, 'build.sh'), 'utf8');
  assert.match(buildScript, /verify-release-manifest\.mjs/);
  assert.match(buildScript, /--profile production/);
  assert.match(buildScript, /VERSION="\$MANIFEST_VERSION"/);
  assert.doesNotMatch(buildScript, /app\.json.*expo.*version/);
});
