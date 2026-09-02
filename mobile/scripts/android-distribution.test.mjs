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
  createExpoConfig,
  loadRepositoryInputs,
  readJson,
  resolveBuildContext,
} = require('./release-manifest.cjs');
const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(MOBILE_ROOT, '..');
const FULL_GIT_SHA = '1234567890abcdef1234567890abcdef12345678';
const TEST_PUBLIC_KEY = '11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=';
const INSTALL_PERMISSION = 'android.permission.REQUEST_INSTALL_PACKAGES';
const INSTALL_PLUGIN = './plugins/withInstallPermission';

function contextFor(distribution, updater = false) {
  const environment = {
    EXPO_PUBLIC_V1_PROFILE: 'preview',
    MOBILE_BUILD_PLATFORM: 'android',
    MOBILE_ANDROID_DISTRIBUTION: distribution,
    ...(updater
      ? {
          MOBILE_ENTERPRISE_UPDATER_ENABLED: 'true',
          MOBILE_ENTERPRISE_UPDATE_MANIFEST_URL:
            'https://updates.example.test/android/enterprise/latest.json',
          MOBILE_ENTERPRISE_UPDATE_PUBLIC_KEY: TEST_PUBLIC_KEY,
          MOBILE_ENTERPRISE_UPDATE_KEY_ID: 'm10-04-test-key',
        }
      : {}),
  };
  return {
    environment,
    context: resolveBuildContext({
      environment,
      explicitGitSha: FULL_GIT_SHA,
      skipGitLookup: true,
    }),
  };
}

function runExpoConfig(distribution, updater = false) {
  const { environment } = contextFor(distribution, updater);
  return spawnSync('pnpm', ['exec', 'expo', 'config', '--type', 'public', '--json'], {
    cwd: MOBILE_ROOT,
    env: { ...process.env, ...environment },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function evidence(result) {
  return `status=${result.status}\nstdout=${result.stdout ?? ''}\nstderr=${result.stderr ?? ''}`;
}

function pluginNames(config) {
  return (config.plugins ?? []).map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
}

test('M10-04 Store config produces AAB capability with no install permission or updater path', () => {
  const { manifest, staticExpoConfig } = loadRepositoryInputs();
  const { context } = contextFor('store');
  const config = createExpoConfig(staticExpoConfig, { manifest, context });

  assert.deepEqual(config.extra.androidDistribution, {
    flavor: 'store',
    artifactType: 'aab',
    enterpriseUpdaterEnabled: false,
  });
  assert.equal(config.extra.enterpriseUpdater, undefined);
  assert.equal(config.android.permissions.includes(INSTALL_PERMISSION), false);
  assert.equal(pluginNames(config).includes(INSTALL_PLUGIN), false);
});

test('M10-04 Enterprise updater defaults off and requires flag plus verification configuration', () => {
  const { manifest, staticExpoConfig } = loadRepositoryInputs();
  const disabled = createExpoConfig(staticExpoConfig, {
    manifest,
    context: contextFor('enterprise').context,
  });
  assert.equal(disabled.extra.androidDistribution.artifactType, 'apk');
  assert.equal(disabled.extra.androidDistribution.enterpriseUpdaterEnabled, false);
  assert.equal(disabled.extra.enterpriseUpdater, undefined);
  assert.equal(disabled.android.permissions.includes(INSTALL_PERMISSION), false);

  const enabledContext = contextFor('enterprise', true).context;
  const enabled = createExpoConfig(staticExpoConfig, { manifest, context: enabledContext });
  assert.equal(enabled.extra.androidDistribution.enterpriseUpdaterEnabled, true);
  assert.deepEqual(enabled.extra.enterpriseUpdater, {
    enabled: true,
    manifestUrl: 'https://updates.example.test/android/enterprise/latest.json',
    publicKey: TEST_PUBLIC_KEY,
    keyId: 'm10-04-test-key',
  });
  assert.equal(
    enabled.android.permissions.filter((permission) => permission === INSTALL_PERMISSION).length,
    1,
  );
  assert.equal(pluginNames(enabled).filter((plugin) => plugin === INSTALL_PLUGIN).length, 1);

  assert.throws(
    () =>
      resolveBuildContext({
        environment: {
          EXPO_PUBLIC_V1_PROFILE: 'preview',
          MOBILE_ANDROID_DISTRIBUTION: 'enterprise',
          MOBILE_ENTERPRISE_UPDATER_ENABLED: 'true',
        },
        skipGitLookup: true,
      }),
    /MOBILE_ENTERPRISE_UPDATE_MANIFEST_URL/,
  );
  assert.throws(
    () =>
      resolveBuildContext({
        environment: {
          ...contextFor('enterprise', true).environment,
          MOBILE_ANDROID_DISTRIBUTION: 'store',
        },
        skipGitLookup: true,
      }),
    /only be enabled for the enterprise Android distribution/,
  );
});

test('M10-04 EAS profiles map Store to AAB and Enterprise to APK while production stays ambiguous', () => {
  const eas = readJson(resolve(MOBILE_ROOT, 'eas.json'));
  assert.equal(eas.build['production-store'].distribution, 'store');
  assert.equal(eas.build['production-store'].android.buildType, 'app-bundle');
  assert.equal(eas.build['production-store'].android.credentialsSource, 'local');
  assert.equal(eas.build['production-enterprise'].distribution, 'internal');
  assert.equal(eas.build['production-enterprise'].android.buildType, 'apk');
  assert.equal(eas.build['production-enterprise'].android.credentialsSource, 'local');
  assert.equal(eas.build.production.env.MOBILE_ANDROID_DISTRIBUTION, undefined);

  const ambiguous = structuredClone(readJson(RELEASE_MANIFEST_PATH));
  ambiguous.version.androidVersionCode = 86;
  ambiguous.version.latestPublished = {
    marketingVersion: '1.9.5',
    iosBuildNumber: 84,
    androidVersionCode: 85,
  };
  ambiguous.target = {
    profile: 'production',
    distribution: 'enterprise',
    gitSha: FULL_GIT_SHA,
  };
  ambiguous.verification = {
    identity: 'verified',
    versions: 'verified',
    distribution: 'verified',
  };
  const { staticExpoConfig } = loadRepositoryInputs();
  assert.throws(
    () =>
      createExpoConfig(staticExpoConfig, {
        manifest: ambiguous,
        context: {
          profile: 'production',
          platform: 'android',
          distribution: null,
          sourceGitSha: FULL_GIT_SHA,
          enterpriseUpdater: { enabled: false },
        },
      }),
    /Android distribution is not explicitly selected/,
  );
});

test('M10-04 public Expo config resolves both Android distributions', () => {
  const storeResult = runExpoConfig('store');
  assert.equal(storeResult.status, 0, evidence(storeResult));
  const store = JSON.parse(storeResult.stdout);
  assert.equal(store.extra.androidDistribution.flavor, 'store');
  assert.equal(store.android.permissions.includes(INSTALL_PERMISSION), false);
  assert.equal(pluginNames(store).includes(INSTALL_PLUGIN), false);

  const enterpriseResult = runExpoConfig('enterprise', true);
  assert.equal(enterpriseResult.status, 0, evidence(enterpriseResult));
  const enterprise = JSON.parse(enterpriseResult.stdout);
  assert.equal(enterprise.extra.androidDistribution.flavor, 'enterprise');
  assert.equal(enterprise.extra.androidDistribution.enterpriseUpdaterEnabled, true);
  assert.equal(enterprise.android.permissions.includes(INSTALL_PERMISSION), true);
  assert.equal(pluginNames(enterprise).includes(INSTALL_PLUGIN), true);
});

test('M10-04 root layout starts updater only through a validated Enterprise bootstrap', () => {
  const layout = readFileSync(resolve(MOBILE_ROOT, 'app/_layout.tsx'), 'utf8');
  assert.match(
    layout,
    /function EnterpriseUpdaterBootstrap[\s\S]*useEnterpriseUpdateChecker\(config\)/,
  );
  assert.match(
    layout,
    /enterpriseUpdaterConfig \? \([\s\S]*<EnterpriseUpdaterBootstrap config=\{enterpriseUpdaterConfig\}/,
  );
  const authGateBody = layout.match(/function AuthGate\(\)[\s\S]*?function ThemedApp/)?.[0] ?? '';
  assert.doesNotMatch(authGateBody, /useEnterpriseUpdateChecker\([^c]/);
});

test('M10-04 build wrapper requires distribution and contains no automatic sideload upload', () => {
  const result = spawnSync('bash', ['scripts/build.sh', 'android', '--build'], {
    cwd: MOBILE_ROOT,
    env: { ...process.env, EXPO_PUBLIC_V1_PROFILE: 'production' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, evidence(result));
  assert.match(`${result.stdout}\n${result.stderr}`, /explicitly pass --distribution/);

  const buildScript = readFileSync(resolve(HERE, 'build.sh'), 'utf8');
  assert.match(buildScript, /production-store/);
  assert.match(buildScript, /production-enterprise/);
  assert.match(buildScript, /No upload or overwrite was performed/);
  assert.doesNotMatch(buildScript, /aliyun\s+oss|--force/);
  assert.match(buildScript, /Refusing to overwrite existing Android versionCode/);
});

test('M10-04 repository static config cannot smuggle install capability into every flavor', () => {
  const appJson = readFileSync(resolve(MOBILE_ROOT, 'app.json'), 'utf8');
  assert.doesNotMatch(appJson, /REQUEST_INSTALL_PACKAGES/);
  assert.doesNotMatch(appJson, /withInstallPermission/);
  assert.equal(resolve(REPOSITORY_ROOT, 'mobile'), MOBILE_ROOT);
});
