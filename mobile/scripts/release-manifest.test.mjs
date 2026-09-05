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
  assertIosSubmitConfiguration,
  assertProductionBuildEnvironment,
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
  manifest.version.iosBuildNumber = 2;
  manifest.version.androidVersionCode = 2;
  manifest.version.latestPublished = {
    marketingVersion: '0.9.0',
    iosBuildNumber: 1,
    androidVersionCode: 1,
  };
  manifest.target = {
    profile: 'production',
    distribution: 'enterprise',
    gitSha: FULL_GIT_SHA,
  };
  manifest.oauthCallback.enabled.production = true;
  manifest.oauthCallback.profiles.production = ['https://mobile.example.test/oauth/callback'];
  manifest.verification = {
    identity: 'verified',
    versions: 'verified',
    distribution: 'verified',
  };
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
    'MOBILE_BUILD_PLATFORM',
    'EAS_BUILD_PLATFORM',
    'MOBILE_ANDROID_DISTRIBUTION',
    'EXPO_PUBLIC_ANDROID_DISTRIBUTION',
    'MOBILE_ENTERPRISE_UPDATER_ENABLED',
    'MOBILE_ENTERPRISE_UPDATE_MANIFEST_URL',
    'MOBILE_ENTERPRISE_UPDATE_PUBLIC_KEY',
    'MOBILE_ENTERPRISE_UPDATE_KEY_ID',
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

test('M10-03 manifest schema accepts the checked-in iOS-first release record', () => {
  const manifest = cloneManifest();
  assert.equal(validateManifestSchema(manifest), manifest);
  assert.equal(manifest.verification.identity, 'verified');
  assert.equal(manifest.schemaVersion, 4);
  assert.equal(manifest.identity.iosAscAppId, '6808382989');
  assert.equal(manifest.verification.versions, 'verified');
  assert.equal(manifest.version.androidVersionCode, null);
  assert.equal(manifest.target.distribution, null);
  assert.equal(manifest.verification.distribution, 'pending-external-verification');
  assert.equal(manifest.oauthCallback.enabled.production, false);
  assert.deepEqual(manifest.oauthCallback.profiles.production, []);
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

  const legacyAscApp = cloneManifest();
  legacyAscApp.identity.iosAscAppId = '6760248115';
  assert.throws(() => validateManifestSchema(legacyAscApp), /must not reuse the legacy KY Agent app/);
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

test('M10-03 OAuth enablement and callback allowlist cannot disagree', () => {
  const disabledWithCallback = cloneManifest();
  disabledWithCallback.oauthCallback.profiles.production = [
    'https://agent.kaiyan.net/oauth/callback',
  ];
  assert.throws(
    () => validateManifestSchema(disabledWithCallback),
    /must be empty when OAuth is disabled/,
  );

  const enabledWithoutCallback = cloneManifest();
  enabledWithoutCallback.oauthCallback.enabled.production = true;
  assert.throws(
    () => validateManifestSchema(enabledWithoutCallback),
    /must not be empty when OAuth is enabled/,
  );
});

test('M10-03 monotonic release rules reject regressions and reused build integers', () => {
  const marketingRegression = productionReadyManifest();
  marketingRegression.version.latestPublished.marketingVersion = '1.9.6';
  assert.throws(() => validateManifestSchema(marketingRegression), /marketingVersion is lower/);

  const reusedIosBuild = productionReadyManifest();
  reusedIosBuild.version.latestPublished.iosBuildNumber = 85;
  assert.throws(() => validateManifestSchema(reusedIosBuild), /iosBuildNumber must be greater/);

  const reusedAndroidCode = productionReadyManifest();
  reusedAndroidCode.version.androidVersionCode = 1;
  assert.throws(
    () => validateManifestSchema(reusedAndroidCode),
    /androidVersionCode must be greater/,
  );
});

test('M10-03 production requires verified identity/version facts and all release target fields', () => {
  const manifest = cloneManifest();
  manifest.target.profile = null;
  manifest.verification.identity = 'pending-external-verification';
  manifest.verification.versions = 'pending-external-verification';
  assert.throws(
    () =>
      assertProductionReady(manifest, {
        profile: 'production',
        platform: 'android',
        distribution: 'enterprise',
        sourceGitSha: FULL_GIT_SHA,
      }),
    (error) => {
      assert.match(error.message, /target\.profile is missing/);
      assert.match(error.message, /target\.distribution is missing/);
      assert.match(error.message, /distribution is pending external verification/);
      assert.match(error.message, /identity is pending external verification/);
      assert.match(error.message, /versions are pending external verification/);
      assert.match(error.message, /androidVersionCode is missing/);
      return true;
    },
  );
});

test('M10-03 iOS-first production does not invent Android, OAuth, or prior-version facts', () => {
  const manifest = cloneManifest();
  assert.doesNotThrow(() =>
    assertProductionReady(manifest, {
      profile: 'production',
      platform: 'ios',
      distribution: null,
      sourceGitSha: FULL_GIT_SHA,
    }),
  );
  assert.equal(manifest.version.androidVersionCode, null);
  assert.deepEqual(manifest.version.latestPublished, {
    marketingVersion: null,
    iosBuildNumber: null,
    androidVersionCode: null,
  });
});

test('M10-03 production target profile and exact Git SHA must match', () => {
  const manifest = productionReadyManifest();
  assert.doesNotThrow(() =>
    assertProductionReady(manifest, {
      profile: 'production',
      platform: 'android',
      distribution: 'enterprise',
      sourceGitSha: FULL_GIT_SHA,
    }),
  );

  const profileMismatch = productionReadyManifest();
  profileMismatch.target.profile = 'preview';
  assert.throws(
    () =>
      assertProductionReady(profileMismatch, {
        profile: 'production',
        platform: 'android',
        distribution: 'enterprise',
        sourceGitSha: FULL_GIT_SHA,
      }),
    /target\.profile mismatch/,
  );

  assert.throws(
    () =>
      assertProductionReady(manifest, {
        profile: 'production',
        platform: 'android',
        distribution: 'enterprise',
        sourceGitSha: 'abcdef1234567890abcdef1234567890abcdef12',
      }),
    /Git SHA mismatch/,
  );
});

test('M60-04 one reviewed manifest may authorize Store and Enterprise artifacts from the same SHA', () => {
  const manifest = productionReadyManifest();
  manifest.target.distribution = 'both';
  assert.equal(validateManifestSchema(manifest), manifest);
  for (const distribution of ['store', 'enterprise']) {
    assert.doesNotThrow(() => assertProductionReady(manifest, {
      profile: 'production',
      platform: 'android',
      distribution,
      sourceGitSha: FULL_GIT_SHA,
    }));
  }
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
    assert.deepEqual(config.extra.oauthCallback.allowlist, ['agent-saas://oauth/callback']);
    assert.equal(config.android.intentFilters[0].autoVerify, false);
    assert.equal(config.extra.releaseManifest.version.androidVersionCode, 'not-set');
  }
});

test('P4 APNs entitlement 的 aps-environment 由 release profile 决定', () => {
  const { manifest, staticExpoConfig } = loadRepositoryInputs();
  for (const profile of ['development', 'preview']) {
    const config = createExpoConfig(staticExpoConfig, {
      manifest,
      context: { profile, sourceGitSha: FULL_GIT_SHA },
    });
    assert.equal(config.ios.entitlements['aps-environment'], 'development');
  }
  const productionConfig = createExpoConfig(staticExpoConfig, {
    manifest: productionReadyManifest(),
    context: {
      profile: 'production',
      platform: 'ios',
      distribution: 'enterprise',
      sourceGitSha: FULL_GIT_SHA,
    },
  });
  assert.equal(productionConfig.ios.entitlements['aps-environment'], 'production');
  // 静态 app.json 不得自带该 entitlement，避免绕过 profile 判定。
  assert.equal(staticExpoConfig.ios?.entitlements?.['aps-environment'], undefined);
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
  const sourceDrift = createExpoConfig(staticExpoConfig, { manifest, context });
  sourceDrift.ios.infoPlist.AgentSaaSReleaseSourceGitSHA = 'f'.repeat(40);
  assert.throws(
    () => assertExpoIdentityMatchesManifest(sourceDrift, manifest, context),
    /Expo identity mismatch.*AgentSaaSReleaseSourceGitSHA/s,
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

test('M10-03 production EAS environment is complete and identity-bound', () => {
  const { manifest, mobileEasConfig } = loadRepositoryInputs();
  assert.doesNotThrow(() => assertProductionBuildEnvironment(mobileEasConfig, manifest));
  assert.doesNotThrow(() => assertIosSubmitConfiguration(mobileEasConfig, manifest));

  const drifted = structuredClone(mobileEasConfig);
  drifted.build.production.env.MOBILE_IOS_SHARE_APP_GROUP = 'group.com.attacker.share';
  assert.throws(
    () => assertProductionBuildEnvironment(drifted, manifest),
    /App Group does not match/,
  );

  const credentialed = structuredClone(mobileEasConfig);
  credentialed.build.production.env.EXPO_PUBLIC_MOBILE_API_ORIGIN =
    'https://user:password@api.agent.kaiyan.net';
  assert.throws(
    () => assertProductionBuildEnvironment(credentialed, manifest),
    /credential-free HTTPS origin/,
  );

  const submitDrift = structuredClone(mobileEasConfig);
  submitDrift.submit.production.ios.ascAppId = '6760248115';
  assert.throws(
    () => assertIosSubmitConfiguration(submitDrift, manifest),
    /ascAppId does not match/,
  );
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
  assert.equal(
    expoConfig.ios.infoPlist.AgentSaaSReleaseSourceGitSHA,
    expoConfig.extra.releaseManifest.sourceGitSha,
  );
  assert.equal(expoConfig.extra.releaseManifest.version.androidVersionCode, 'not-set');
});

test('M10-03 production config is fail closed with the checked-in unverified manifest', () => {
  const { staticExpoConfig, manifest } = loadRepositoryInputs();
  assert.throws(
    () =>
      createExpoConfig(staticExpoConfig, {
        manifest,
        context: {
          profile: 'production',
          platform: 'android',
          distribution: 'enterprise',
          sourceGitSha: FULL_GIT_SHA,
        },
      }),
    /Production release is blocked/,
  );
});

test('M10-03 checked-in production manifest authorizes iOS without Android release facts', () => {
  const sourceGitSha = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  }).stdout.trim();
  const result = spawnSync(process.execPath, [
    'scripts/verify-release-manifest.mjs',
    '--profile', 'production',
    '--platform', 'ios',
    '--git-sha', sourceGitSha,
    '--print-build-values',
  ], {
    cwd: MOBILE_ROOT,
    env: cleanExpoEnvironment('production'),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, commandEvidence(result));
  assert.equal(result.stdout, '1.0.0|\n');
});

test('M10-03 build script reads release version through the manifest verifier', () => {
  const buildScript = readFileSync(resolve(HERE, 'build.sh'), 'utf8');
  assert.match(buildScript, /verify-release-manifest\.mjs/);
  assert.match(buildScript, /--profile production/);
  assert.match(buildScript, /--print-build-values/);
  assert.match(buildScript, /MANIFEST_VERSION ANDROID_VERSION_CODE/);
  assert.doesNotMatch(buildScript, /app\.json.*expo.*version/);
});
