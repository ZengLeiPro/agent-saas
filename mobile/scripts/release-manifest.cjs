'use strict';

const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { dirname, join, resolve } = require('node:path');

const MOBILE_ROOT = resolve(__dirname, '..');
const REPOSITORY_ROOT = resolve(MOBILE_ROOT, '..');
const RELEASE_MANIFEST_PATH = join(MOBILE_ROOT, 'release-manifest.json');
const STATIC_EXPO_CONFIG_PATH = join(MOBILE_ROOT, 'app.json');
const MOBILE_EAS_CONFIG_PATH = join(MOBILE_ROOT, 'eas.json');
const ROOT_EAS_CONFIG_PATH = join(REPOSITORY_ROOT, 'eas.json');
const RELEASE_PROFILES = Object.freeze(['development', 'preview', 'production']);
const ANDROID_DISTRIBUTIONS = Object.freeze(['store', 'enterprise']);
const BUILD_PLATFORMS = Object.freeze(['android', 'ios']);
const VERIFICATION_STATES = Object.freeze(['pending-external-verification', 'verified']);
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REQUEST_INSTALL_PACKAGES = 'android.permission.REQUEST_INSTALL_PACKAGES';
const INSTALL_PERMISSION_PLUGIN = './plugins/withInstallPermission';
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

class ReleaseManifestError extends Error {
  constructor(message) {
    super(`[M10-03] ${message}`);
    this.name = 'ReleaseManifestError';
  }
}

function fail(message) {
  throw new ReleaseManifestError(message);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail(`Unable to read JSON at ${path}: ${reason}`);
  }
}

function assertRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
}

function assertExactKeys(value, path, expectedKeys) {
  assertRecord(value, path);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  const missing = expected.filter((key) => !actual.includes(key));
  const unexpected = actual.filter((key) => !expected.includes(key));
  if (missing.length || unexpected.length) {
    const details = [];
    if (missing.length) details.push(`missing ${missing.join(', ')}`);
    if (unexpected.length) details.push(`unexpected ${unexpected.join(', ')}`);
    fail(`${path} schema mismatch (${details.join('; ')})`);
  }
}

function assertNonEmptyString(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`${path} must be a non-empty string`);
  }
}

function assertNullablePositiveInteger(value, path, { required = false } = {}) {
  if (value === null && !required) return;
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${path} must be a positive safe integer${required ? '' : ' or null'}`);
  }
}

function parseSemver(value, path) {
  if (typeof value !== 'string') fail(`${path} must be a semantic version string`);
  const match = SEMVER_PATTERN.exec(value);
  if (!match) fail(`${path} must be valid SemVer (for example 1.9.5)`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) < Number(rightPart) ? -1 : 1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function compareSemver(leftValue, rightValue) {
  const left = parseSemver(leftValue, 'left semantic version');
  const right = parseSemver(rightValue, 'right semantic version');
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

function validateManifestSchema(manifest) {
  assertExactKeys(manifest, 'release manifest', [
    'schemaVersion',
    'identity',
    'version',
    'target',
    'verification',
  ]);
  if (manifest.schemaVersion !== 2) fail('release manifest.schemaVersion must be 2');

  assertExactKeys(manifest.identity, 'release manifest.identity', [
    'displayName',
    'slug',
    'scheme',
    'iosBundleIdentifier',
    'androidPackage',
    'easProjectId',
    'easOwner',
  ]);
  for (const key of Object.keys(manifest.identity)) {
    assertNonEmptyString(manifest.identity[key], `release manifest.identity.${key}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(manifest.identity.slug)) {
    fail('release manifest.identity.slug has an invalid Expo slug');
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(manifest.identity.scheme)) {
    fail('release manifest.identity.scheme has an invalid URL scheme');
  }
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(manifest.identity.iosBundleIdentifier)) {
    fail('release manifest.identity.iosBundleIdentifier has an invalid bundle identifier');
  }
  if (
    !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(manifest.identity.androidPackage)
  ) {
    fail('release manifest.identity.androidPackage has an invalid Android package');
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      manifest.identity.easProjectId,
    )
  ) {
    fail('release manifest.identity.easProjectId must be a UUID');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(manifest.identity.easOwner)) {
    fail('release manifest.identity.easOwner has an invalid EAS account name');
  }

  assertExactKeys(manifest.version, 'release manifest.version', [
    'marketingVersion',
    'iosBuildNumber',
    'androidVersionCode',
    'latestPublished',
  ]);
  parseSemver(manifest.version.marketingVersion, 'release manifest.version.marketingVersion');
  assertNullablePositiveInteger(
    manifest.version.iosBuildNumber,
    'release manifest.version.iosBuildNumber',
    { required: true },
  );
  assertNullablePositiveInteger(
    manifest.version.androidVersionCode,
    'release manifest.version.androidVersionCode',
  );

  assertExactKeys(manifest.version.latestPublished, 'release manifest.version.latestPublished', [
    'marketingVersion',
    'iosBuildNumber',
    'androidVersionCode',
  ]);
  const latest = manifest.version.latestPublished;
  if (latest.marketingVersion !== null) {
    parseSemver(
      latest.marketingVersion,
      'release manifest.version.latestPublished.marketingVersion',
    );
    if (compareSemver(manifest.version.marketingVersion, latest.marketingVersion) < 0) {
      fail('marketingVersion is lower than latestPublished.marketingVersion');
    }
  }
  assertNullablePositiveInteger(
    latest.iosBuildNumber,
    'release manifest.version.latestPublished.iosBuildNumber',
  );
  assertNullablePositiveInteger(
    latest.androidVersionCode,
    'release manifest.version.latestPublished.androidVersionCode',
  );
  if (latest.iosBuildNumber !== null && manifest.version.iosBuildNumber <= latest.iosBuildNumber) {
    fail('iosBuildNumber must be greater than latestPublished.iosBuildNumber');
  }
  if (
    latest.androidVersionCode !== null &&
    (manifest.version.androidVersionCode === null ||
      manifest.version.androidVersionCode <= latest.androidVersionCode)
  ) {
    fail('androidVersionCode must be greater than latestPublished.androidVersionCode');
  }

  assertExactKeys(manifest.target, 'release manifest.target', [
    'profile',
    'distribution',
    'gitSha',
  ]);
  if (manifest.target.profile !== null && !RELEASE_PROFILES.includes(manifest.target.profile)) {
    fail(`release manifest.target.profile must be one of ${RELEASE_PROFILES.join(', ')} or null`);
  }
  if (
    manifest.target.distribution !== null &&
    !ANDROID_DISTRIBUTIONS.includes(manifest.target.distribution)
  ) {
    fail(
      `release manifest.target.distribution must be one of ${ANDROID_DISTRIBUTIONS.join(', ')} or null`,
    );
  }
  if (manifest.target.gitSha !== null && !GIT_SHA_PATTERN.test(manifest.target.gitSha)) {
    fail('release manifest.target.gitSha must be a full 40-character Git SHA or null');
  }

  assertExactKeys(manifest.verification, 'release manifest.verification', [
    'identity',
    'versions',
    'distribution',
  ]);
  for (const key of ['identity', 'versions', 'distribution']) {
    if (!VERIFICATION_STATES.includes(manifest.verification[key])) {
      fail(`release manifest.verification.${key} must be one of ${VERIFICATION_STATES.join(', ')}`);
    }
  }
  return manifest;
}

function assertProductionReady(manifest, context) {
  if (context.profile !== 'production') return;
  const blockers = [];
  if (manifest.target.profile === null) blockers.push('target.profile is missing');
  else if (manifest.target.profile !== context.profile) {
    blockers.push(
      `target.profile mismatch (manifest=${manifest.target.profile}, requested=${context.profile})`,
    );
  }

  // Android production is deliberately ambiguous until a human selects the
  // Store or Enterprise channel. iOS-only verification does not consume this
  // Android fact; every other production context fails closed without it.
  if (context.platform !== 'ios') {
    if (!context.distribution) blockers.push('Android distribution is not explicitly selected');
    if (manifest.target.distribution === null) blockers.push('target.distribution is missing');
    else if (context.distribution && manifest.target.distribution !== context.distribution) {
      blockers.push(
        `target.distribution mismatch (manifest=${manifest.target.distribution}, requested=${context.distribution})`,
      );
    }
    if (manifest.verification.distribution !== 'verified') {
      blockers.push('distribution is pending external verification');
    }
  }

  if (manifest.target.gitSha === null) blockers.push('target.gitSha is missing');
  if (!context.sourceGitSha) blockers.push('source Git SHA is unavailable');
  else if (
    manifest.target.gitSha &&
    manifest.target.gitSha.toLowerCase() !== context.sourceGitSha.toLowerCase()
  ) {
    blockers.push(
      `Git SHA mismatch (manifest=${manifest.target.gitSha}, source=${context.sourceGitSha})`,
    );
  }
  if (manifest.verification.identity !== 'verified') {
    blockers.push('identity is pending external verification');
  }
  if (manifest.verification.versions !== 'verified') {
    blockers.push('versions are pending external verification');
  }
  if (manifest.version.androidVersionCode === null) {
    blockers.push('androidVersionCode is missing');
  }
  for (const [key, value] of Object.entries(manifest.version.latestPublished)) {
    if (value === null) blockers.push(`latestPublished.${key} is missing`);
  }
  if (blockers.length) {
    fail(`Production release is blocked:\n- ${blockers.join('\n- ')}`);
  }
}

function easBuildProfileReleaseProfile(value) {
  if (RELEASE_PROFILES.includes(value)) return value;
  for (const profile of RELEASE_PROFILES) {
    for (const distribution of ANDROID_DISTRIBUTIONS) {
      if (value === `${profile}-${distribution}`) return profile;
    }
  }
  return null;
}

function easBuildProfileDistribution(value) {
  for (const profile of RELEASE_PROFILES) {
    for (const distribution of ANDROID_DISTRIBUTIONS) {
      if (value === `${profile}-${distribution}`) return distribution;
    }
  }
  return null;
}

function resolveRequestedProfile(environment = {}, explicitProfile) {
  const sources = [
    ['--profile', explicitProfile],
    ['MOBILE_RELEASE_PROFILE', environment.MOBILE_RELEASE_PROFILE],
    ['EXPO_PUBLIC_V1_PROFILE', environment.EXPO_PUBLIC_V1_PROFILE],
  ].filter(([, value]) => typeof value === 'string' && value.trim());
  if (typeof environment.EAS_BUILD_PROFILE === 'string' && environment.EAS_BUILD_PROFILE.trim()) {
    const easProfile = environment.EAS_BUILD_PROFILE.trim();
    const releaseProfile = easBuildProfileReleaseProfile(easProfile);
    if (!releaseProfile) fail(`unsupported EAS build profile ${easProfile}`);
    sources.push([`EAS_BUILD_PROFILE=${easProfile}`, releaseProfile]);
  }
  const normalized = sources.map(([label, value]) => [label, value.trim()]);
  const distinct = [...new Set(normalized.map(([, value]) => value))];
  if (distinct.length > 1) {
    fail(
      `release profile mismatch (${normalized.map(([label, value]) => `${label}=${value}`).join(', ')})`,
    );
  }
  const profile = distinct[0] ?? 'development';
  if (!RELEASE_PROFILES.includes(profile)) {
    fail(`unsupported release profile ${profile}; expected ${RELEASE_PROFILES.join(', ')}`);
  }
  return profile;
}

function resolveRequestedDistribution(environment = {}, explicitDistribution) {
  const sources = [
    ['--distribution', explicitDistribution],
    ['MOBILE_ANDROID_DISTRIBUTION', environment.MOBILE_ANDROID_DISTRIBUTION],
    ['EXPO_PUBLIC_ANDROID_DISTRIBUTION', environment.EXPO_PUBLIC_ANDROID_DISTRIBUTION],
  ].filter(([, value]) => typeof value === 'string' && value.trim());
  if (typeof environment.EAS_BUILD_PROFILE === 'string' && environment.EAS_BUILD_PROFILE.trim()) {
    const easProfile = environment.EAS_BUILD_PROFILE.trim();
    const distribution = easBuildProfileDistribution(easProfile);
    if (distribution) sources.push([`EAS_BUILD_PROFILE=${easProfile}`, distribution]);
  }
  const normalized = sources.map(([label, value]) => [label, value.trim().toLowerCase()]);
  const distinct = [...new Set(normalized.map(([, value]) => value))];
  if (distinct.length > 1) {
    fail(
      `Android distribution mismatch (${normalized.map(([label, value]) => `${label}=${value}`).join(', ')})`,
    );
  }
  const distribution = distinct[0] ?? null;
  if (distribution !== null && !ANDROID_DISTRIBUTIONS.includes(distribution)) {
    fail(
      `unsupported Android distribution ${distribution}; expected ${ANDROID_DISTRIBUTIONS.join(', ')}`,
    );
  }
  return distribution;
}

function resolveBuildPlatform(environment = {}, explicitPlatform) {
  const sources = [
    ['--platform', explicitPlatform],
    ['MOBILE_BUILD_PLATFORM', environment.MOBILE_BUILD_PLATFORM],
    ['EAS_BUILD_PLATFORM', environment.EAS_BUILD_PLATFORM],
  ].filter(([, value]) => typeof value === 'string' && value.trim());
  const normalized = sources.map(([label, value]) => [label, value.trim().toLowerCase()]);
  const distinct = [...new Set(normalized.map(([, value]) => value))];
  if (distinct.length > 1) {
    fail(
      `build platform mismatch (${normalized.map(([label, value]) => `${label}=${value}`).join(', ')})`,
    );
  }
  const platform = distinct[0] ?? null;
  if (platform !== null && !BUILD_PLATFORMS.includes(platform)) {
    fail(`unsupported build platform ${platform}; expected ${BUILD_PLATFORMS.join(', ')}`);
  }
  return platform;
}

function parseControlledBoolean(value, name) {
  if (value === undefined || value === '') return false;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  fail(`${name} must be one of 1, true, 0, false`);
}

function assertCanonicalPublicKey(value) {
  assertNonEmptyString(value, 'MOBILE_ENTERPRISE_UPDATE_PUBLIC_KEY');
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    fail('MOBILE_ENTERPRISE_UPDATE_PUBLIC_KEY must be canonical base64 for a 32-byte Ed25519 key');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    fail('MOBILE_ENTERPRISE_UPDATE_PUBLIC_KEY must decode to exactly 32 bytes');
  }
}

function resolveEnterpriseUpdater(environment, distribution) {
  const enabled = parseControlledBoolean(
    environment.MOBILE_ENTERPRISE_UPDATER_ENABLED,
    'MOBILE_ENTERPRISE_UPDATER_ENABLED',
  );
  if (!enabled) return Object.freeze({ enabled: false });
  if (distribution !== 'enterprise') {
    fail('Enterprise updater can only be enabled for the enterprise Android distribution');
  }

  const manifestUrl = environment.MOBILE_ENTERPRISE_UPDATE_MANIFEST_URL;
  const publicKey = environment.MOBILE_ENTERPRISE_UPDATE_PUBLIC_KEY;
  const keyId = environment.MOBILE_ENTERPRISE_UPDATE_KEY_ID;
  assertNonEmptyString(manifestUrl, 'MOBILE_ENTERPRISE_UPDATE_MANIFEST_URL');
  assertCanonicalPublicKey(publicKey);
  assertNonEmptyString(keyId, 'MOBILE_ENTERPRISE_UPDATE_KEY_ID');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    fail('MOBILE_ENTERPRISE_UPDATE_KEY_ID has an invalid key identifier');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(manifestUrl);
  } catch {
    fail('MOBILE_ENTERPRISE_UPDATE_MANIFEST_URL must be a valid HTTPS URL');
  }
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.hash
  ) {
    fail('MOBILE_ENTERPRISE_UPDATE_MANIFEST_URL must be credential-free HTTPS without a fragment');
  }

  return Object.freeze({ enabled: true, manifestUrl, publicKey, keyId });
}

function tryReadRepositoryGitSha(repositoryRoot) {
  const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) return null;
  const value = result.stdout.trim();
  return GIT_SHA_PATTERN.test(value) ? value.toLowerCase() : null;
}

function resolveSourceGitSha({
  environment = {},
  explicitGitSha,
  repositoryRoot = REPOSITORY_ROOT,
  skipGitLookup = false,
} = {}) {
  const sources = [
    ['--git-sha', explicitGitSha],
    ['MOBILE_SOURCE_GIT_SHA', environment.MOBILE_SOURCE_GIT_SHA],
    ['EAS_BUILD_GIT_COMMIT_HASH', environment.EAS_BUILD_GIT_COMMIT_HASH],
    ['GITHUB_SHA', environment.GITHUB_SHA],
  ].filter(([, value]) => typeof value === 'string' && value.trim());
  if (!skipGitLookup) {
    const repositorySha = tryReadRepositoryGitSha(repositoryRoot);
    if (repositorySha) sources.push(['git HEAD', repositorySha]);
  }
  const normalized = sources.map(([label, value]) => {
    const sha = value.trim().toLowerCase();
    if (!GIT_SHA_PATTERN.test(sha)) fail(`${label} must be a full 40-character Git SHA`);
    return [label, sha];
  });
  const distinct = [...new Set(normalized.map(([, value]) => value))];
  if (distinct.length > 1) {
    fail(
      `Git SHA mismatch (${normalized.map(([label, value]) => `${label}=${value}`).join(', ')})`,
    );
  }
  return distinct[0] ?? null;
}

function resolveBuildContext(options = {}) {
  const environment = options.environment ?? {};
  const distribution = resolveRequestedDistribution(environment, options.explicitDistribution);
  return {
    profile: resolveRequestedProfile(environment, options.explicitProfile),
    platform: resolveBuildPlatform(environment, options.explicitPlatform),
    distribution,
    sourceGitSha: resolveSourceGitSha({ ...options, environment }),
    enterpriseUpdater: resolveEnterpriseUpdater(environment, distribution),
  };
}

function hasOwnPath(value, path) {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return false;
    current = current[segment];
  }
  return true;
}

function pluginReference(plugin) {
  return Array.isArray(plugin) ? plugin[0] : plugin;
}

function assertStaticExpoConfigHasNoReleaseFields(staticExpoConfig) {
  assertRecord(staticExpoConfig, 'mobile/app.json expo config');
  const protectedPaths = [
    ['name'],
    ['slug'],
    ['scheme'],
    ['version'],
    ['owner'],
    ['ios', 'bundleIdentifier'],
    ['ios', 'buildNumber'],
    ['android', 'package'],
    ['android', 'versionCode'],
    ['extra', 'eas', 'projectId'],
    ['extra', 'releaseManifest'],
    ['extra', 'androidDistribution'],
    ['extra', 'enterpriseUpdater'],
  ];
  const duplicates = protectedPaths
    .filter((path) => hasOwnPath(staticExpoConfig, path))
    .map((path) => path.join('.'));
  if (duplicates.length) {
    fail(`mobile/app.json duplicates release-manifest.json fields: ${duplicates.join(', ')}`);
  }
  const permissions = staticExpoConfig.android?.permissions ?? [];
  if (permissions.includes(REQUEST_INSTALL_PACKAGES)) {
    fail('mobile/app.json must not grant REQUEST_INSTALL_PACKAGES outside an Enterprise build');
  }
  if (
    (staticExpoConfig.plugins ?? []).some(
      (plugin) => pluginReference(plugin) === INSTALL_PERMISSION_PLUGIN,
    )
  ) {
    fail('mobile/app.json must not register the Enterprise install-permission plugin statically');
  }
}

function assertEasVersionPolicy(easConfig, label, { requireProfiles = false } = {}) {
  assertRecord(easConfig, label);
  if (easConfig.cli?.appVersionSource !== 'local') {
    fail(`${label} cli.appVersionSource must be "local"`);
  }
  const buildProfiles = easConfig.build ?? {};
  for (const [profile, profileConfig] of Object.entries(buildProfiles)) {
    if (profileConfig?.autoIncrement !== undefined && profileConfig.autoIncrement !== false) {
      fail(`${label} build.${profile}.autoIncrement must be absent or false`);
    }
  }
  if (!requireProfiles) return;
  for (const profile of RELEASE_PROFILES) {
    const profileConfig = buildProfiles[profile];
    if (!profileConfig) fail(`${label} build.${profile} is missing`);
    const declaredProfile = profileConfig.env?.EXPO_PUBLIC_V1_PROFILE;
    if (declaredProfile !== profile) {
      fail(
        `${label} build.${profile} profile identity mismatch (EXPO_PUBLIC_V1_PROFILE=${declaredProfile ?? '<missing>'})`,
      );
    }
  }

  if (buildProfiles.production.env?.MOBILE_ANDROID_DISTRIBUTION) {
    fail(`${label} build.production must remain distribution-ambiguous and fail closed`);
  }
  const expectedProfiles = {
    'production-store': {
      distribution: 'store',
      easDistribution: 'store',
      buildType: 'app-bundle',
    },
    'production-enterprise': {
      distribution: 'enterprise',
      easDistribution: 'internal',
      buildType: 'apk',
    },
  };
  for (const [profileName, expected] of Object.entries(expectedProfiles)) {
    const profileConfig = buildProfiles[profileName];
    if (!profileConfig) fail(`${label} build.${profileName} is missing`);
    if (profileConfig.env?.EXPO_PUBLIC_V1_PROFILE !== 'production') {
      fail(`${label} build.${profileName} must declare EXPO_PUBLIC_V1_PROFILE=production`);
    }
    if (profileConfig.env?.MOBILE_ANDROID_DISTRIBUTION !== expected.distribution) {
      fail(
        `${label} build.${profileName} must declare MOBILE_ANDROID_DISTRIBUTION=${expected.distribution}`,
      );
    }
    if (profileConfig.distribution !== expected.easDistribution) {
      fail(`${label} build.${profileName}.distribution must be ${expected.easDistribution}`);
    }
    if (profileConfig.android?.buildType !== expected.buildType) {
      fail(`${label} build.${profileName}.android.buildType must be ${expected.buildType}`);
    }
    if (profileConfig.android?.credentialsSource !== 'local') {
      fail(`${label} build.${profileName}.android.credentialsSource must be local`);
    }
  }
}

function createArtifactIdentity(manifest, context) {
  return {
    schemaVersion: manifest.schemaVersion,
    profile: context.profile,
    distribution: context.distribution ?? 'unselected',
    sourceGitSha: context.sourceGitSha ?? 'unavailable',
    target: {
      profile: manifest.target.profile ?? 'not-set',
      distribution: manifest.target.distribution ?? 'not-set',
      gitSha: manifest.target.gitSha ?? 'not-set',
    },
    identity: { ...manifest.identity },
    version: {
      marketingVersion: manifest.version.marketingVersion,
      iosBuildNumber: manifest.version.iosBuildNumber,
      androidVersionCode: manifest.version.androidVersionCode ?? 'not-set',
    },
    capabilities: {
      enterpriseUpdater: context.enterpriseUpdater?.enabled === true,
    },
    verification: { ...manifest.verification },
  };
}

function createExpoConfig(staticExpoConfig, options = {}) {
  const manifest = validateManifestSchema(
    options.manifest ?? readJson(options.manifestPath ?? RELEASE_MANIFEST_PATH),
  );
  const context = options.context ?? resolveBuildContext({ environment: options.environment });
  assertProductionReady(manifest, context);
  const artifactIdentity = createArtifactIdentity(manifest, context);
  const androidVersion =
    manifest.version.androidVersionCode === null
      ? {}
      : { versionCode: manifest.version.androidVersionCode };
  const updater = context.enterpriseUpdater?.enabled === true ? context.enterpriseUpdater : null;
  const permissions = (staticExpoConfig.android?.permissions ?? []).filter(
    (permission) => permission !== REQUEST_INSTALL_PACKAGES,
  );
  const plugins = (staticExpoConfig.plugins ?? []).filter(
    (plugin) => pluginReference(plugin) !== INSTALL_PERMISSION_PLUGIN,
  );
  if (updater) {
    permissions.push(REQUEST_INSTALL_PACKAGES);
    plugins.push(INSTALL_PERMISSION_PLUGIN);
  }
  const artifactType =
    context.distribution === 'store'
      ? 'aab'
      : context.distribution === 'enterprise'
        ? 'apk'
        : 'none';

  return {
    ...staticExpoConfig,
    name: manifest.identity.displayName,
    slug: manifest.identity.slug,
    scheme: manifest.identity.scheme,
    version: manifest.version.marketingVersion,
    owner: manifest.identity.easOwner,
    ios: {
      ...(staticExpoConfig.ios ?? {}),
      bundleIdentifier: manifest.identity.iosBundleIdentifier,
      buildNumber: String(manifest.version.iosBuildNumber),
    },
    android: {
      ...(staticExpoConfig.android ?? {}),
      // Non-production origins may deliberately use HTTP for local development.
      // Production is always explicit and fail-closed at the native manifest layer.
      usesCleartextTraffic: context.profile !== 'production',
      allowBackup: false,
      permissions,
      package: manifest.identity.androidPackage,
      ...androidVersion,
    },
    plugins,
    extra: {
      ...(staticExpoConfig.extra ?? {}),
      eas: {
        projectId: manifest.identity.easProjectId,
      },
      releaseManifest: artifactIdentity,
      androidDistribution: {
        flavor: context.distribution ?? 'unselected',
        artifactType,
        enterpriseUpdaterEnabled: updater !== null,
      },
      ...(updater
        ? {
            enterpriseUpdater: {
              enabled: true,
              manifestUrl: updater.manifestUrl,
              publicKey: updater.publicKey,
              keyId: updater.keyId,
            },
          }
        : {}),
    },
  };
}

function assertExpoIdentityMatchesManifest(expoConfig, manifest, context) {
  validateManifestSchema(manifest);
  const expectedArtifact = createArtifactIdentity(manifest, context);
  const checks = [
    ['name', expoConfig.name, manifest.identity.displayName],
    ['slug', expoConfig.slug, manifest.identity.slug],
    ['scheme', expoConfig.scheme, manifest.identity.scheme],
    ['version', expoConfig.version, manifest.version.marketingVersion],
    ['owner', expoConfig.owner, manifest.identity.easOwner],
    [
      'ios.bundleIdentifier',
      expoConfig.ios?.bundleIdentifier,
      manifest.identity.iosBundleIdentifier,
    ],
    ['ios.buildNumber', expoConfig.ios?.buildNumber, String(manifest.version.iosBuildNumber)],
    ['android.package', expoConfig.android?.package, manifest.identity.androidPackage],
    ['extra.eas.projectId', expoConfig.extra?.eas?.projectId, manifest.identity.easProjectId],
  ];
  if (manifest.version.androidVersionCode === null) {
    if (expoConfig.android?.versionCode !== undefined) {
      checks.push(['android.versionCode', expoConfig.android.versionCode, '<absent>']);
    }
  } else {
    checks.push([
      'android.versionCode',
      expoConfig.android?.versionCode,
      manifest.version.androidVersionCode,
    ]);
  }
  const mismatches = checks
    .filter(([, actual, expected]) => actual !== expected)
    .map(
      ([path, actual, expected]) => `${path} expected ${String(expected)}, got ${String(actual)}`,
    );
  if (JSON.stringify(expoConfig.extra?.releaseManifest) !== JSON.stringify(expectedArtifact)) {
    mismatches.push('extra.releaseManifest does not match the expected artifact identity');
  }

  const updaterEnabled = context.enterpriseUpdater?.enabled === true;
  const expectedDistribution = context.distribution ?? 'unselected';
  const expectedArtifactType =
    context.distribution === 'store'
      ? 'aab'
      : context.distribution === 'enterprise'
        ? 'apk'
        : 'none';
  const distributionConfig = expoConfig.extra?.androidDistribution;
  if (distributionConfig?.flavor !== expectedDistribution) {
    mismatches.push(
      `extra.androidDistribution.flavor expected ${expectedDistribution}, got ${String(distributionConfig?.flavor)}`,
    );
  }
  if (distributionConfig?.artifactType !== expectedArtifactType) {
    mismatches.push(
      `extra.androidDistribution.artifactType expected ${expectedArtifactType}, got ${String(distributionConfig?.artifactType)}`,
    );
  }
  if (distributionConfig?.enterpriseUpdaterEnabled !== updaterEnabled) {
    mismatches.push(
      'extra.androidDistribution.enterpriseUpdaterEnabled does not match build policy',
    );
  }

  if (expoConfig.android?.allowBackup !== false) {
    mismatches.push('android.allowBackup must be false');
  }
  const expectedCleartext = context.profile !== 'production';
  if (expoConfig.android?.usesCleartextTraffic !== expectedCleartext) {
    mismatches.push(
      `android.usesCleartextTraffic expected ${expectedCleartext}, got ${String(expoConfig.android?.usesCleartextTraffic)}`,
    );
  }

  const permissions = expoConfig.android?.permissions ?? [];
  const installPermissionCount = permissions.filter(
    (permission) => permission === REQUEST_INSTALL_PACKAGES,
  ).length;
  const installPluginCount = (expoConfig.plugins ?? []).filter(
    (plugin) => pluginReference(plugin) === INSTALL_PERMISSION_PLUGIN,
  ).length;
  if (updaterEnabled) {
    if (installPermissionCount !== 1) {
      mismatches.push(
        'Enterprise updater requires exactly one REQUEST_INSTALL_PACKAGES permission',
      );
    }
    if (installPluginCount !== 1) {
      mismatches.push('Enterprise updater requires exactly one install-permission plugin');
    }
    const expectedUpdater = {
      enabled: true,
      manifestUrl: context.enterpriseUpdater.manifestUrl,
      publicKey: context.enterpriseUpdater.publicKey,
      keyId: context.enterpriseUpdater.keyId,
    };
    if (JSON.stringify(expoConfig.extra?.enterpriseUpdater) !== JSON.stringify(expectedUpdater)) {
      mismatches.push('extra.enterpriseUpdater does not match controlled build inputs');
    }
  } else {
    if (installPermissionCount !== 0) {
      mismatches.push('non-updater builds must not request REQUEST_INSTALL_PACKAGES');
    }
    if (installPluginCount !== 0) {
      mismatches.push('non-updater builds must not register the install-permission plugin');
    }
    if (expoConfig.extra?.enterpriseUpdater !== undefined) {
      mismatches.push('non-updater builds must not expose an Enterprise updater runtime config');
    }
  }
  if (mismatches.length) {
    fail(`Expo identity mismatch:\n- ${mismatches.join('\n- ')}`);
  }
}

function loadRepositoryInputs(manifestPath = RELEASE_MANIFEST_PATH) {
  return {
    manifest: readJson(manifestPath),
    staticExpoConfig: readJson(STATIC_EXPO_CONFIG_PATH).expo,
    mobileEasConfig: readJson(MOBILE_EAS_CONFIG_PATH),
    rootEasConfig: readJson(ROOT_EAS_CONFIG_PATH),
  };
}

function verifyRepositoryReleaseConfiguration({
  manifest,
  staticExpoConfig,
  mobileEasConfig,
  rootEasConfig,
  context,
  expoConfig,
}) {
  validateManifestSchema(manifest);
  assertProductionReady(manifest, context);
  assertStaticExpoConfigHasNoReleaseFields(staticExpoConfig);
  assertEasVersionPolicy(mobileEasConfig, 'mobile/eas.json', { requireProfiles: true });
  assertEasVersionPolicy(rootEasConfig, 'root eas.json guard');
  const resolvedExpoConfig =
    expoConfig ?? createExpoConfig(staticExpoConfig, { manifest, context });
  assertExpoIdentityMatchesManifest(resolvedExpoConfig, manifest, context);
  return createArtifactIdentity(manifest, context);
}

module.exports = {
  ANDROID_DISTRIBUTIONS,
  GIT_SHA_PATTERN,
  MOBILE_EAS_CONFIG_PATH,
  MOBILE_ROOT,
  RELEASE_MANIFEST_PATH,
  RELEASE_PROFILES,
  REPOSITORY_ROOT,
  ROOT_EAS_CONFIG_PATH,
  STATIC_EXPO_CONFIG_PATH,
  ReleaseManifestError,
  assertEasVersionPolicy,
  assertExpoIdentityMatchesManifest,
  assertProductionReady,
  assertStaticExpoConfigHasNoReleaseFields,
  compareSemver,
  createArtifactIdentity,
  createExpoConfig,
  loadRepositoryInputs,
  readJson,
  resolveBuildContext,
  resolveBuildPlatform,
  resolveEnterpriseUpdater,
  resolveRequestedDistribution,
  resolveRequestedProfile,
  resolveSourceGitSha,
  validateManifestSchema,
  verifyRepositoryReleaseConfiguration,
};
