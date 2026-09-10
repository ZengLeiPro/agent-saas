import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';
import {
  classifyInternalBuildState,
  createAppStoreToken,
  validateInternalGroup,
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

test('internal TestFlight state distinguishes ready, blocked, failed and waiting builds', () => {
  assert.equal(classifyInternalBuildState('IN_BETA_TESTING'), 'ready');
  assert.equal(classifyInternalBuildState('MISSING_EXPORT_COMPLIANCE'), 'blocked');
  assert.equal(classifyInternalBuildState('PROCESSING_EXCEPTION'), 'failed');
  assert.equal(classifyInternalBuildState('EXPIRED'), 'failed');
  assert.equal(classifyInternalBuildState('READY_FOR_BETA_TESTING'), 'waiting');
  assert.equal(classifyInternalBuildState('PROCESSING'), 'waiting');
});

test('internal TestFlight group must match the reviewed all-builds group', () => {
  const group = {
    id: 'a21bd778-a7de-43ee-97ca-3f6f5877d237',
    attributes: {
      name: 'kaiyan',
      isInternalGroup: true,
      hasAccessToAllBuilds: true,
    },
  };
  const expected = { id: group.id, name: 'kaiyan' };
  assert.equal(validateInternalGroup(group, expected), group);
  assert.throws(() => validateInternalGroup({ ...group, id: 'wrong' }, expected));
  assert.throws(() =>
    validateInternalGroup(
      { ...group, attributes: { ...group.attributes, name: 'other' } },
      expected,
    ),
  );
  assert.throws(() =>
    validateInternalGroup(
      { ...group, attributes: { ...group.attributes, hasAccessToAllBuilds: false } },
      expected,
    ),
  );
});
