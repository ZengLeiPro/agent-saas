#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const API = 'https://api.appstoreconnect.apple.com/v1';
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const base64url = (value) => Buffer.from(value).toString('base64url');

export function createAppStoreToken({ keyId, issuerId, privateKey, now = Date.now() }) {
  assert.match(keyId, /^[A-Z0-9]{10}$/u, 'Invalid App Store Connect key ID');
  assert.match(
    issuerId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
    'Invalid App Store Connect issuer ID',
  );
  const issuedAt = Math.floor(now / 1000);
  const encoded = `${base64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: issuerId, iat: issuedAt, exp: issuedAt + 900, aud: 'appstoreconnect-v1' }))}`;
  const signature = sign('sha256', Buffer.from(encoded), {
    key: createPrivateKey(privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  assert.equal(signature.length, 64, 'Unexpected ES256 signature length');
  return `${encoded}.${signature.toString('base64url')}`;
}

export function classifyInternalBuildState(state) {
  if (state === 'IN_BETA_TESTING') return 'ready';
  if (['PROCESSING_EXCEPTION', 'EXPIRED'].includes(state)) return 'failed';
  if (state === 'MISSING_EXPORT_COMPLIANCE') return 'blocked';
  return 'waiting';
}

export function validateInternalGroup(group, expected) {
  assert.equal(group?.id, expected.id, 'TestFlight internal group ID mismatch');
  assert.equal(group?.attributes?.name, expected.name, 'TestFlight internal group name mismatch');
  assert.equal(group?.attributes?.isInternalGroup, true, 'Configured TestFlight group is not internal');
  assert.equal(
    group?.attributes?.hasAccessToAllBuilds,
    true,
    'Internal TestFlight group must automatically receive all builds',
  );
  return group;
}

class AppStoreClient {
  constructor(credentials) {
    this.credentials = credentials;
  }

  async request(path) {
    assert.ok(path.startsWith('/') && !path.includes('..'), 'Unsafe App Store Connect API path');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${API}${path}`, {
        headers: {
          Authorization: `Bearer ${createAppStoreToken(this.credentials)}`,
          Accept: 'application/json',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 204) return null;
      const payload = await response.json().catch(() => ({}));
      if (response.ok) return payload;
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await sleep(2_000 * (attempt + 1));
        continue;
      }
      const details = (payload.errors ?? [])
        .map(
          (error) =>
            `${error.code ?? response.status}: ${error.detail ?? error.title ?? 'request failed'}`,
        )
        .join('; ');
      throw new Error(
        `App Store Connect GET ${path.split('?')[0]} failed: ${details || `HTTP ${response.status}`}`,
      );
    }
    throw new Error('App Store Connect retry limit exceeded');
  }
}

function query(values) {
  return new URLSearchParams(values).toString();
}

async function findBuild(client, appId, version, buildNumber) {
  const response = await client.request(
    `/builds?${query({
      'filter[app]': appId,
      'filter[version]': buildNumber,
      'filter[preReleaseVersion.version]': version,
      include: 'preReleaseVersion',
      limit: '200',
    })}`,
  );
  const matches = response.data ?? [];
  assert.ok(matches.length <= 1, 'App Store Connect returned ambiguous exact-version builds');
  return matches[0] ?? null;
}

async function waitForBuild(
  client,
  identity,
  { timeoutMs = 90 * 60_000, intervalMs = 20_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const build = await findBuild(client, identity.appId, identity.version, identity.buildNumber);
    const state = build?.attributes?.processingState;
    if (state === 'VALID') return build;
    if (state === 'FAILED' || state === 'INVALID')
      throw new Error(`Apple build processing failed with state ${state}`);
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for Apple to finish build processing');
}

function uploadIpa(ipaPath, credentials, privateKeysDirectory) {
  mkdirSync(privateKeysDirectory, { recursive: true, mode: 0o700 });
  const keyPath = join(privateKeysDirectory, `AuthKey_${credentials.keyId}.p8`);
  writeFileSync(keyPath, credentials.privateKey, { mode: 0o600, flag: 'wx' });
  const descriptor = openSync(ipaPath, 'r');
  try {
    const result = spawnSync(
      'xcrun',
      [
        'altool',
        '--upload-app',
        '--file',
        '/dev/fd/3',
        '--type',
        'ios',
        '--apiKey',
        credentials.keyId,
        '--apiIssuer',
        credentials.issuerId,
        '--output-format',
        'json',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, API_PRIVATE_KEYS_DIR: privateKeysDirectory },
        stdio: ['ignore', 'pipe', 'pipe', descriptor],
        timeout: 45 * 60_000,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const message = `${result.stdout}\n${result.stderr}`
        .replaceAll(credentials.keyId, '[key-id]')
        .slice(-6000);
      throw new Error(`Apple binary upload failed (exit ${result.status}): ${message}`);
    }
    return `${result.stdout}\n${result.stderr}`.trim().slice(-6000);
  } finally {
    closeSync(descriptor);
    unlinkSync(keyPath);
  }
}

async function findInternalGroup(client, identity) {
  const response = await client.request(
    `/betaGroups?${query({ 'filter[app]': identity.appId, limit: '200' })}`,
  );
  const group = (response.data ?? []).find((item) => item.id === identity.betaGroupId);
  assert.ok(group, 'Configured internal TestFlight group does not belong to the app');
  return validateInternalGroup(group, {
    id: identity.betaGroupId,
    name: identity.betaGroupName,
  });
}

async function waitForInternalTesting(
  client,
  build,
  { timeoutMs = 30 * 60_000, intervalMs = 20_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const detail = (await client.request(`/builds/${build.id}/buildBetaDetail`)).data;
    const state = detail?.attributes?.internalBuildState;
    const classification = classifyInternalBuildState(state);
    if (classification === 'ready') return detail;
    if (classification === 'blocked') {
      throw new Error('TestFlight is blocked by missing export compliance information');
    }
    if (classification === 'failed') {
      throw new Error(`TestFlight internal distribution failed with state ${state}`);
    }
    await sleep(intervalMs);
  }
  throw new Error('Timed out waiting for the build to enter internal TestFlight testing');
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    assert.ok(name?.startsWith('--') && value, `Invalid argument ${name ?? '<missing>'}`);
    values[name.slice(2)] = value;
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const ipaPath = resolve(args.ipa);
  const source = JSON.parse(
    execFileSync('jq', ['-c', '.', `${ipaPath}.source.json`], { encoding: 'utf8' }),
  );
  const appId = process.env.APP_STORE_CONNECT_APP_ID;
  const betaGroupId = process.env.TESTFLIGHT_INTERNAL_GROUP_ID;
  const betaGroupName = process.env.TESTFLIGHT_INTERNAL_GROUP_NAME;
  const credentials = {
    keyId: process.env.APP_STORE_CONNECT_API_KEY_ID,
    issuerId: process.env.APP_STORE_CONNECT_ISSUER_ID,
    privateKey: process.env.APP_STORE_CONNECT_API_KEY_P8,
  };
  assert.match(appId ?? '', /^[1-9][0-9]+$/u, 'APP_STORE_CONNECT_APP_ID is required');
  assert.match(
    betaGroupId ?? '',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
    'TESTFLIGHT_INTERNAL_GROUP_ID is required',
  );
  assert.ok(betaGroupName, 'TESTFLIGHT_INTERNAL_GROUP_NAME is required');
  assert.ok(
    credentials.privateKey?.includes('BEGIN PRIVATE KEY'),
    'APP_STORE_CONNECT_API_KEY_P8 is invalid',
  );
  createAppStoreToken(credentials);
  const identity = {
    appId,
    version: source.version,
    buildNumber: String(source.buildNumber),
    betaGroupId,
    betaGroupName,
  };
  const client = new AppStoreClient(credentials);
  const group = await findInternalGroup(client, identity);
  let build = await findBuild(client, appId, identity.version, identity.buildNumber);
  let uploadStatus = 'already-present';
  let uploadSummary = '';
  if (!build) {
    try {
      uploadSummary = uploadIpa(
        ipaPath,
        credentials,
        join(process.env.HOME, '.appstoreconnect/private_keys'),
      );
      uploadStatus = 'uploaded';
    } catch (error) {
      build = await findBuild(client, appId, identity.version, identity.buildNumber);
      if (!build) throw error;
      uploadStatus = 'accepted-before-client-error';
      uploadSummary = error.message.slice(-2000);
    }
  }
  build = await waitForBuild(client, identity);
  const betaDetail = await waitForInternalTesting(client, build);
  const result = {
    schemaVersion: 1,
    appId,
    version: identity.version,
    buildNumber: identity.buildNumber,
    buildId: build.id,
    processingState: build.attributes.processingState,
    uploadStatus,
    betaGroupId: group.id,
    betaGroupName: group.attributes.name,
    hasAccessToAllBuilds: group.attributes.hasAccessToAllBuilds,
    internalBuildState: betaDetail.attributes.internalBuildState,
    autoNotifyEnabled: betaDetail.attributes.autoNotifyEnabled,
    recordedAt: new Date().toISOString(),
  };
  assert.equal(result.processingState, 'VALID');
  assert.equal(result.hasAccessToAllBuilds, true);
  assert.equal(result.internalBuildState, 'IN_BETA_TESTING');
  writeFileSync(resolve(args.result), `${JSON.stringify(result, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    const uploadNote = uploadSummary
      ? `\n\nApple upload tool: ${uploadSummary.split('\n').at(-1)}`
      : '';
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Internal TestFlight\n\nBuild ${identity.version} (${identity.buildNumber}): ${result.processingState}\n\nInternal testing: ${result.internalBuildState}\n\nGroup: ${result.betaGroupName} (all builds)${uploadNote}\n`,
      { flag: 'a' },
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[App Store Connect] ${error.message}`);
    process.exitCode = 1;
  });
}
