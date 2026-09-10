import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import {
  classifyAppStoreVersionState,
  createAppStoreToken,
  releaseRequestBodies,
} from './app-store-connect.mjs';

test('App Store token is a short-lived ES256 JWT with the requested key identity', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const now = Date.parse('2026-09-10T00:00:00Z');
  const token = createAppStoreToken({
    keyId: 'WUQL8DV33D',
    issuerId: '69a6de84-4e94-47e3-e053-5b8c7c11a4d1',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    now,
  });
  const [header, payload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), {
    alg: 'ES256',
    kid: 'WUQL8DV33D',
    typ: 'JWT',
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
    iss: '69a6de84-4e94-47e3-e053-5b8c7c11a4d1',
    iat: 1788998400,
    exp: 1788999300,
    aud: 'appstoreconnect-v1',
  });
  assert.equal(
    verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
    true,
  );
});

test('review submission bodies bind one exact app, version and processed build', () => {
  const bodies = releaseRequestBodies({
    appId: '6808382989',
    versionId: 'version-1',
    buildId: 'build-1',
    submissionId: 'review-1',
  });
  assert.equal(bodies.automaticRelease.data.attributes.releaseType, 'AFTER_APPROVAL');
  assert.deepEqual(bodies.attachBuild.data, { type: 'builds', id: 'build-1' });
  assert.deepEqual(bodies.createSubmission.data.relationships.app.data, {
    type: 'apps',
    id: '6808382989',
  });
  assert.deepEqual(bodies.createItem.data.relationships.appStoreVersion.data, {
    type: 'appStoreVersions',
    id: 'version-1',
  });
  assert.deepEqual(bodies.createItem.data.relationships.reviewSubmission.data, {
    type: 'reviewSubmissions',
    id: 'review-1',
  });
  assert.equal(bodies.submit.data.attributes.submitted, true);
});

test('review retry distinguishes submitted, rejected and still-editable App Store versions', () => {
  assert.equal(classifyAppStoreVersionState('WAITING_FOR_REVIEW'), 'submitted');
  assert.equal(classifyAppStoreVersionState('IN_REVIEW'), 'submitted');
  assert.equal(classifyAppStoreVersionState('READY_FOR_DISTRIBUTION'), 'submitted');
  assert.equal(classifyAppStoreVersionState('REJECTED'), 'failed');
  assert.equal(classifyAppStoreVersionState('INVALID_BINARY'), 'failed');
  assert.equal(classifyAppStoreVersionState('PREPARE_FOR_SUBMISSION'), 'editable');
  assert.equal(classifyAppStoreVersionState('READY_FOR_REVIEW'), 'editable');
});
