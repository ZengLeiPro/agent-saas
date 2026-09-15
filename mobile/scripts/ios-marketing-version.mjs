import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { compareSemver, parseSemver } = require('./release-manifest.cjs');

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function query(values) {
  return new URLSearchParams(values).toString();
}

export function trimMarketingVersionInput(value) {
  if (value == null) return '';
  assert.equal(typeof value, 'string', '营销版本必须是字符串');
  return value.trim();
}

export function parseStrictSemver(value, label = '营销版本') {
  assert.equal(typeof value, 'string', `${label}必须是字符串`);
  const text = value.trim();
  assert.ok(text, `${label}不能为空`);
  assert.ok(SEMVER_PATTERN.test(text), `${label}必须是严格 SemVer（例如 1.2.3），收到：${JSON.stringify(text)}`);
  // Reject build-metadata-only surprises by round-tripping through the shared parser.
  parseSemver(text, label);
  return text;
}

export function assertMarketingVersionAllowed(candidate, published) {
  const version = parseStrictSemver(candidate, '营销版本');
  if (!published) return version;
  const current = parseStrictSemver(published.version, 'App Store Connect 当前短版本');
  if (compareSemver(version, current) < 0) {
    throw new Error(
      `营销版本 ${version} 低于 App Store Connect 当前短版本 ${current}（来源：${published.source}）；允许相等以便同一营销版本继续追加构建号`,
    );
  }
  return version;
}

function maxSemver(versions) {
  assert.ok(versions.length > 0, '缺少可比较的版本');
  return versions.reduce((best, item) => (compareSemver(item, best) > 0 ? item : best));
}

function assertAscSemver(value, context) {
  try {
    return parseStrictSemver(value, 'App Store Connect 短版本');
  } catch (error) {
    throw new Error(
      `App Store Connect 返回了无法按严格 SemVer 解析的短版本 ${JSON.stringify(value)}（${context}）：${error.message}`,
    );
  }
}

/**
 * Published marketing/short version for iOS:
 * Live App Store short version if present, else latest usable TestFlight short version.
 * Returns null when the app has never published a usable short version (first release).
 */
export async function resolvePublishedShortVersion(client, appId) {
  assert.match(String(appId ?? ''), /^[1-9][0-9]+$/u, 'App Store Connect App ID 无效');

  const liveResponse = await client.request(
    `/apps/${appId}/appStoreVersions?${query({
      'filter[platform]': 'IOS',
      'filter[appStoreState]': 'READY_FOR_SALE',
      'fields[appStoreVersions]': 'versionString,appStoreState,platform',
      limit: '50',
    })}`,
  );
  assert.ok(Array.isArray(liveResponse?.data), 'App Store Connect Live 版本列表缺失');
  const liveVersions = [];
  for (const item of liveResponse.data) {
    const versionString = item?.attributes?.versionString;
    if (!versionString) continue;
    liveVersions.push(assertAscSemver(versionString, 'Live READY_FOR_SALE'));
  }
  if (liveVersions.length > 0) {
    return { version: maxSemver(liveVersions), source: 'live' };
  }

  const trains = await client.request(
    `/preReleaseVersions?${query({
      'filter[app]': appId,
      'filter[platform]': 'IOS',
      'fields[preReleaseVersions]': 'version,platform',
      limit: '200',
    })}`,
  );
  assert.ok(Array.isArray(trains?.data), 'App Store Connect TestFlight 预发布版本列表缺失');
  const usable = [];
  for (const train of trains.data) {
    const version = train?.attributes?.version;
    if (!version || !train.id) continue;
    const parsed = assertAscSemver(version, 'TestFlight preReleaseVersion');
    const builds = await client.request(
      `/preReleaseVersions/${train.id}/builds?${query({
        'fields[builds]': 'processingState,expired',
        limit: '50',
      })}`,
    );
    assert.ok(Array.isArray(builds?.data), 'App Store Connect TestFlight builds 列表缺失');
    const hasUsable = builds.data.some(
      (build) => build?.attributes?.processingState === 'VALID' && build?.attributes?.expired === false,
    );
    if (hasUsable) usable.push(parsed);
  }
  if (usable.length === 0) return null;
  return { version: maxSemver(usable), source: 'testflight' };
}

/**
 * Resolve the marketing version for a new iOS build.
 * Blank input → ASC published (fail if first release).
 * Filled input → SemVer ≥ published (equality allowed).
 * Never falls back to release-manifest.json marketingVersion.
 */
export async function resolveReleaseMarketingVersion(input, { client, appId }) {
  const trimmed = trimMarketingVersionInput(input);
  let published;
  try {
    published = await resolvePublishedShortVersion(client, appId);
  } catch (error) {
    throw new Error(
      `无法从 App Store Connect 解析当前 iOS 短版本，已失败关闭且不会回退到 release-manifest 中的 marketingVersion：${error.message}`,
    );
  }

  if (!trimmed) {
    if (!published) {
      throw new Error(
        '首次 iOS 发布：App Store Connect 尚无 Live/可用 TestFlight 短版本。请在 workflow_dispatch 表单填写 marketing_version 作为种子版本（例如 1.0.0）；不会静默使用 1.0.0 或仓库内 marketingVersion',
      );
    }
    return {
      marketingVersion: published.version,
      source: published.source,
      published,
      input: '',
    };
  }

  const marketingVersion = assertMarketingVersionAllowed(trimmed, published);
  return {
    marketingVersion,
    source: 'input',
    published,
    input: trimmed,
  };
}

export function applyMarketingVersionToManifest(root, marketingVersion) {
  const version = parseStrictSemver(marketingVersion, '营销版本');
  const path = join(root, 'mobile/release-manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(manifest?.version && typeof manifest.version === 'object', 'release-manifest.version 缺失');
  // Neutralize stale git latestPublished.marketingVersion so ASC/input wins for this
  // working tree only. Never touch androidVersionCode / iosBuildNumber bases.
  manifest.version.marketingVersion = version;
  if (manifest.version.latestPublished && typeof manifest.version.latestPublished === 'object') {
    manifest.version.latestPublished.marketingVersion = null;
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { path, marketingVersion: version };
}
