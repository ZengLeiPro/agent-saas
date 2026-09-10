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

export function releaseRequestBodies({ appId, versionId, buildId, submissionId }) {
  const result = {
    automaticRelease: {
      data: {
        type: 'appStoreVersions',
        id: versionId,
        attributes: { releaseType: 'AFTER_APPROVAL' },
      },
    },
    attachBuild: { data: { type: 'builds', id: buildId } },
    createSubmission: {
      data: {
        type: 'reviewSubmissions',
        relationships: { app: { data: { type: 'apps', id: appId } } },
      },
    },
  };
  if (submissionId) {
    result.createItem = {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    };
    result.submit = {
      data: { type: 'reviewSubmissions', id: submissionId, attributes: { submitted: true } },
    };
  }
  return result;
}

class AppStoreClient {
  constructor(credentials) {
    this.credentials = credentials;
  }

  async request(path, { method = 'GET', body, allow404 = false } = {}) {
    assert.ok(path.startsWith('/') && !path.includes('..'), 'Unsafe App Store Connect API path');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${createAppStoreToken(this.credentials)}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 204) return null;
      if (allow404 && response.status === 404) return null;
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
        `App Store Connect ${method} ${path.split('?')[0]} failed: ${details || `HTTP ${response.status}`}`,
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

async function findVersion(client, appId, version) {
  const response = await client.request(
    `/apps/${appId}/appStoreVersions?${query({
      'filter[platform]': 'IOS',
      'filter[versionString]': version,
      limit: '200',
    })}`,
  );
  const matches = response.data ?? [];
  assert.equal(
    matches.length,
    1,
    `App Store version ${version} must already exist with complete reviewed metadata`,
  );
  return matches[0];
}

async function findSubmission(client, appId, versionId) {
  const response = await client.request(
    `/apps/${appId}/reviewSubmissions?${query({
      include: 'appStoreVersionForReview',
      limit: '200',
    })}`,
  );
  return (
    (response.data ?? []).find(
      (item) => item.relationships?.appStoreVersionForReview?.data?.id === versionId,
    ) ?? null
  );
}

async function ensureSubmissionItem(client, submissionId, versionId) {
  const response = await client.request(
    `/reviewSubmissions/${submissionId}/items?${query({
      include: 'appStoreVersion',
      limit: '50',
    })}`,
  );
  const matches = (response.data ?? []).filter(
    (item) => item.relationships?.appStoreVersion?.data?.id === versionId,
  );
  assert.ok(matches.length <= 1, 'Review submission contains duplicate App Store version items');
  if (matches.length === 1) return matches[0];
  const bodies = releaseRequestBodies({ appId: '', versionId, buildId: '', submissionId });
  return (
    await client.request('/reviewSubmissionItems', { method: 'POST', body: bodies.createItem })
  ).data;
}

export function classifyAppStoreVersionState(state) {
  if (
    [
      'WAITING_FOR_REVIEW',
      'IN_REVIEW',
      'ACCEPTED',
      'PENDING_APPLE_RELEASE',
      'PENDING_DEVELOPER_RELEASE',
      'PROCESSING_FOR_DISTRIBUTION',
      'READY_FOR_DISTRIBUTION',
    ].includes(state)
  ) {
    return 'submitted';
  }
  if (
    [
      'DEVELOPER_REJECTED',
      'INVALID_BINARY',
      'METADATA_REJECTED',
      'REJECTED',
      'REPLACED_WITH_NEW_VERSION',
    ].includes(state)
  ) {
    return 'failed';
  }
  return 'editable';
}

async function submitForReview(client, identity, build) {
  let version = await findVersion(client, identity.appId, identity.version);
  const versionState = version.attributes?.appStoreState;
  const classification = classifyAppStoreVersionState(versionState);
  if (classification === 'failed')
    throw new Error(`App Store version cannot be resubmitted from state ${versionState}`);
  if (classification === 'submitted') {
    assert.equal(
      version.attributes.releaseType,
      'AFTER_APPROVAL',
      'Existing submitted version is not configured for automatic release',
    );
    const submission = await findSubmission(client, identity.appId, version.id);
    assert.ok(submission, 'Submitted App Store version has no review submission');
    return { version, submission, alreadySubmitted: true };
  }

  const baseBodies = releaseRequestBodies({
    appId: identity.appId,
    versionId: version.id,
    buildId: build.id,
  });
  if (version.attributes?.releaseType !== 'AFTER_APPROVAL') {
    await client.request(`/appStoreVersions/${version.id}`, {
      method: 'PATCH',
      body: baseBodies.automaticRelease,
    });
  }
  await client.request(`/appStoreVersions/${version.id}/relationships/build`, {
    method: 'PATCH',
    body: baseBodies.attachBuild,
  });

  let submission = await findSubmission(client, identity.appId, version.id);
  if (!submission) {
    submission = (
      await client.request('/reviewSubmissions', {
        method: 'POST',
        body: baseBodies.createSubmission,
      })
    ).data;
  }
  await ensureSubmissionItem(client, submission.id, version.id);
  if (submission.attributes?.state === 'READY_FOR_REVIEW' || !submission.attributes?.state) {
    const bodies = releaseRequestBodies({
      appId: identity.appId,
      versionId: version.id,
      buildId: build.id,
      submissionId: submission.id,
    });
    submission = (
      await client.request(`/reviewSubmissions/${submission.id}`, {
        method: 'PATCH',
        body: bodies.submit,
      })
    ).data;
  }
  version = (await client.request(`/appStoreVersions/${version.id}`)).data;
  return { version, submission, alreadySubmitted: false };
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
  const credentials = {
    keyId: process.env.APP_STORE_CONNECT_API_KEY_ID,
    issuerId: process.env.APP_STORE_CONNECT_ISSUER_ID,
    privateKey: process.env.APP_STORE_CONNECT_API_KEY_P8,
  };
  assert.match(appId ?? '', /^[1-9][0-9]+$/u, 'APP_STORE_CONNECT_APP_ID is required');
  assert.ok(
    credentials.privateKey?.includes('BEGIN PRIVATE KEY'),
    'APP_STORE_CONNECT_API_KEY_P8 is invalid',
  );
  createAppStoreToken(credentials);
  const identity = { appId, version: source.version, buildNumber: String(source.buildNumber) };
  const client = new AppStoreClient(credentials);
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
  const release = await submitForReview(client, identity, build);
  const result = {
    schemaVersion: 1,
    appId,
    version: identity.version,
    buildNumber: identity.buildNumber,
    buildId: build.id,
    processingState: build.attributes.processingState,
    uploadStatus,
    appStoreVersionId: release.version.id,
    appStoreState: release.version.attributes?.appStoreState,
    releaseType: release.version.attributes?.releaseType,
    reviewSubmissionId: release.submission?.id ?? null,
    reviewState: release.submission?.attributes?.state ?? null,
    alreadySubmitted: release.alreadySubmitted,
    recordedAt: new Date().toISOString(),
  };
  assert.equal(result.processingState, 'VALID');
  assert.equal(result.releaseType, 'AFTER_APPROVAL');
  assert.ok(
    ['WAITING_FOR_REVIEW', 'IN_REVIEW', 'COMPLETING', 'COMPLETE'].includes(result.reviewState),
    `Review submission did not enter a submitted state: ${result.reviewState}`,
  );
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
      `### App Store Connect\n\nBuild ${identity.version} (${identity.buildNumber}): ${result.processingState}\n\nReview: ${result.reviewState}\n\nRelease: ${result.releaseType}${uploadNote}\n`,
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
