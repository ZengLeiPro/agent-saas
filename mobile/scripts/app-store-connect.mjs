#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createPrivateKey, sign } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SubmissionProgress, UploadIntegrityError, uploadIpa } from './app-store-progress.mjs';

const API = 'https://api.appstoreconnect.apple.com/v1';
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

export class AppStoreClient {
  constructor(credentials, { fetchImpl = fetch } = {}) {
    this.credentials = credentials;
    this.fetch = fetchImpl;
  }

  async request(path, { signal } = {}) {
    assert.ok(path.startsWith('/') && !path.includes('..'), 'Unsafe App Store Connect API path');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      signal?.throwIfAborted();
      let response;
      let payload;
      try {
        response = await this.fetch(`${API}${path}`, {
          headers: {
            Authorization: `Bearer ${createAppStoreToken(this.credentials)}`,
            Accept: 'application/json',
          },
          redirect: 'error',
          signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
        });
        if (response.status === 204) return null;
        payload = await response.json();
      } catch {
        signal?.throwIfAborted();
        if (attempt === 3) throw new Error('App Store Connect request failed (network, timeout or invalid JSON)');
        await delay(2_000 * (attempt + 1), undefined, { signal });
        continue;
      }
      if (response.ok) return payload;
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        await delay(2_000 * (attempt + 1), undefined, { signal });
        continue;
      }
      // Response bodies can echo credentials or arbitrary content. Keep them
      // out of logs and workflow summaries, including on permission failures.
      throw new Error(`App Store Connect request failed (HTTP ${response.status}); check the HTTP status and API key permissions in the Actions diagnostic`);
    }
    throw new Error('App Store Connect retry limit exceeded');
  }
}

function query(values) {
  return new URLSearchParams(values).toString();
}

async function findBuild(client, appId, version, buildNumber, signal) {
  const response = await client.request(
    `/builds?${query({
      'filter[app]': appId,
      'filter[version]': buildNumber,
      'filter[preReleaseVersion.version]': version,
      include: 'preReleaseVersion',
      limit: '200',
    })}`,
    { signal },
  );
  const matches = response.data;
  assert.ok(Array.isArray(matches), 'App Store Connect build collection is missing');
  assert.ok(matches.length <= 1, 'App Store Connect returned ambiguous exact-version builds');
  return matches[0] ?? null;
}

async function waitForVisibility(client, identity, phase, intervalMs) {
  for (;;) {
    phase.signal.throwIfAborted();
    const build = await findBuild(client, identity.appId, identity.version, identity.buildNumber, phase.signal);
    phase.state(build ? 'BUILD_FOUND' : 'NOT_VISIBLE');
    if (build) return build;
    await phase.sleep(intervalMs);
  }
}

async function waitForBuild(client, identity, phase, intervalMs) {
  for (;;) {
    phase.signal.throwIfAborted();
    const build = await findBuild(client, identity.appId, identity.version, identity.buildNumber, phase.signal);
    const state = build?.attributes?.processingState;
    assert.ok(build, 'Previously observed exact build is no longer visible; refusing to infer Apple processing');
    phase.state(state);
    if (state === 'VALID') return build;
    if (state === 'FAILED' || state === 'INVALID')
      throw new Error(`Apple build processing failed with state ${state}`);
    await phase.sleep(intervalMs);
  }
}

async function findInternalGroup(client, identity, signal) {
  const response = await client.request(
    `/betaGroups?${query({ 'filter[app]': identity.appId, limit: '200' })}`,
    { signal },
  );
  const group = (response.data ?? []).find((item) => item.id === identity.betaGroupId);
  assert.ok(group, 'Configured internal TestFlight group does not belong to the app');
  return validateInternalGroup(group, {
    id: identity.betaGroupId,
    name: identity.betaGroupName,
  });
}

async function waitForInternalTesting(client, build, phase, intervalMs) {
  for (;;) {
    phase.signal.throwIfAborted();
    const detail = (await client.request(`/builds/${build.id}/buildBetaDetail`, { signal: phase.signal })).data;
    const state = detail?.attributes?.internalBuildState;
    phase.state(state);
    const classification = classifyInternalBuildState(state);
    if (classification === 'ready') return detail;
    if (classification === 'blocked') {
      throw new Error('TestFlight is blocked by missing export compliance information');
    }
    if (classification === 'failed') {
      throw new Error(`TestFlight internal distribution failed with state ${state}`);
    }
    await phase.sleep(intervalMs);
  }
}

export async function submitToTestFlight({ client, identity, upload, progress }) {
  const limits = progress.limits;
  progress.identify(identity);
  let uploadEvidence = null;
  let group;
  let build = await progress.run('inspect', limits.preflightMs, async (phase) => {
    group = await findInternalGroup(client, identity, phase.signal);
    const found = await findBuild(client, identity.appId, identity.version, identity.buildNumber, phase.signal);
    phase.state(found ? 'BUILD_FOUND' : 'BUILD_NOT_FOUND');
    return found;
  });
  let uploadStatus = 'already-present';
  if (!build) {
    try {
      uploadEvidence = await progress.run('upload', limits.uploadMs, async (phase) => {
        const result = await upload(phase);
        assert.equal(result?.accepted, true, 'Upload success evidence is required');
        phase.state('UPLOAD_REPORTED_SUCCESS');
        return result;
      });
      uploadStatus = 'uploaded';
    } catch (error) {
      // A failed client can follow an accepted upload. Reconcile exact identity,
      // but never ignore cancellation or reset an exhausted overall deadline.
      progress.check();
      if (error instanceof UploadIntegrityError) throw error;
      uploadEvidence = error.diagnostic || null;
      build = await progress.run('reconcile-upload', limits.preflightMs, async (phase) => {
        const found = await findBuild(client, identity.appId, identity.version, identity.buildNumber, phase.signal);
        phase.state(found ? 'BUILD_FOUND' : 'BUILD_NOT_FOUND');
        return found;
      });
      if (!build) throw error;
      uploadStatus = 'accepted-before-client-error';
    }
  }
  if (!build) {
    try {
      build = await progress.run('build-visibility', limits.visibilityMs,
        (phase) => waitForVisibility(client, identity, phase, limits.pollMs));
    } catch (error) {
      progress.check();
      if (error.message === 'build-visibility deadline exceeded') {
        throw new Error('Upload tool reported success, but the exact app/version/build did not become visible before the deadline. Apple processing is NOT confirmed; see the target identity and upload diagnostic in this Actions summary. No automatic reupload was attempted.');
      }
      throw error;
    }
  }
  build = await progress.run('apple-processing', limits.processingMs,
    (phase) => waitForBuild(client, identity, phase, limits.pollMs));
  const betaDetail = await progress.run('internal-testflight', limits.internalMs,
    (phase) => waitForInternalTesting(client, build, phase, limits.pollMs));
  return { group, build, betaDetail, uploadStatus, uploadEvidence };
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
  const controller = new AbortController();
  const onInterrupt = () => controller.abort(new Error('Submission cancelled (SIGINT)'));
  const onTerminate = () => controller.abort(new Error('Submission cancelled (SIGTERM)'));
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  let submission;
  try {
    submission = await submitToTestFlight({
      client: new AppStoreClient(credentials), identity,
      upload: (phase) => uploadIpa(ipaPath, credentials, join(process.env.HOME, '.appstoreconnect/private_keys'), phase),
      progress: new SubmissionProgress({ signal: controller.signal, summaryPath: process.env.GITHUB_STEP_SUMMARY }),
    });
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
  }
  const { group, build, betaDetail, uploadStatus, uploadEvidence } = submission;
  const result = {
    schemaVersion: 1,
    appId,
    version: identity.version,
    buildNumber: identity.buildNumber,
    buildId: build.id,
    processingState: build.attributes.processingState,
    uploadStatus,
    uploadEvidence,
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
    writeFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Internal TestFlight\n\nBuild ${identity.version} (${identity.buildNumber}): ${result.processingState}\n\nInternal testing: ${result.internalBuildState}\n\nGroup: ${result.betaGroupName} (all builds)\n`,
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
