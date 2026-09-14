import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const baseUrl = new URL('../test-vectors/v2/', import.meta.url);
const positive = JSON.parse(await readFile(new URL('positive.json', baseUrl), 'utf8'));
const negative = JSON.parse(await readFile(new URL('negative.json', baseUrl), 'utf8'));

const fail = (message) => {
  throw new Error(`KY App V2 vector integrity error: ${message}`);
};

const stableJson = (value) => JSON.stringify(value);
const decodeJson = (value) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
const publicMembers = new Set(['kty', 'crv', 'x', 'y', 'alg', 'use', 'kid', 'key_ops']);

const thumbprint = (jwk) =>
  createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest('base64url');

if (positive.formatVersion !== 1 || negative.formatVersion !== 1) fail('unsupported formatVersion');
if (positive.keys.platform.keyId === positive.keys.deployment.keyId)
  fail('platform and deployment keys must differ');

for (const [name, key] of Object.entries(positive.keys)) {
  if (key.alg !== 'ES256' || key.publicJwk.kty !== 'EC' || key.publicJwk.crv !== 'P-256') {
    fail(`${name} must be an ES256 P-256 key`);
  }
  for (const member of Object.keys(key.publicJwk)) {
    if (!publicMembers.has(member)) fail(`${name} contains non-public JWK member ${member}`);
  }
  if (thumbprint(key.publicJwk) !== key.keyId) fail(`${name} thumbprint does not match keyId`);
}

const requiredTypes = new Set([
  'ky-enrollment-request+jwt',
  'ky-installation-grant+jwt',
  'ky-client-auth+jwt',
  'ky-workload-at+jwt',
  'dpop+jwt',
  'ky-attest-v2+jwt',
]);
const seenTypes = new Set();
const vectorIds = new Set();

for (const vector of positive.vectors) {
  if (vectorIds.has(vector.id)) fail(`duplicate positive vector id ${vector.id}`);
  vectorIds.add(vector.id);

  const parts = vector.compact.split('.');
  if (parts.length !== 3 || parts.some((part) => !part || part.includes('='))) {
    fail(`${vector.id} is not canonical compact JWS`);
  }
  if (stableJson(decodeJson(parts[0])) !== stableJson(vector.protected))
    fail(`${vector.id} protected header drifted`);
  if (stableJson(decodeJson(parts[1])) !== stableJson(vector.payload))
    fail(`${vector.id} payload drifted`);
  if (vector.protected.alg !== 'ES256' || !requiredTypes.has(vector.protected.typ)) {
    fail(`${vector.id} has an unexpected alg or typ`);
  }
  seenTypes.add(vector.protected.typ);

  const key = positive.keys[vector.signer];
  if (!key) fail(`${vector.id} refers to unknown signer ${vector.signer}`);
  const valid = verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: createPublicKey({ key: key.publicJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(parts[2], 'base64url'),
  );
  if (!valid) fail(`${vector.id} signature is invalid`);
}

const missingTypes = [...requiredTypes].filter((type) => !seenTypes.has(type));
if (missingTypes.length > 0) fail(`missing positive typ vectors: ${missingTypes.join(', ')}`);

const enrollment = positive.vectors.find((vector) => vector.id === 'enrollment-request-valid');
const expectedChallenge = createHash('sha256')
  .update(Buffer.from(positive.context.pkceVerifier, 'ascii'))
  .digest('base64url');
if (enrollment?.payload.code_challenge !== expectedChallenge) {
  fail('enrollment PKCE S256 challenge cannot be reproduced from context.pkceVerifier');
}

for (const id of ['installation-grant-valid', 'attest-valid']) {
  const vector = positive.vectors.find((item) => item.id === id);
  const digest = vector?.payload.registered_digest ?? vector?.payload.manifest_digest;
  if (!/^[0-9a-f]{64}$/u.test(digest ?? '')) fail(`${id} must use the canonical 64-char digest`);
}

const workload = positive.vectors.find((vector) => vector.id === 'workload-token-valid');
const resourceProof = positive.vectors.find((vector) => vector.id === 'dpop-resource-valid');
const expectedAth = createHash('sha256')
  .update(Buffer.from(workload?.compact ?? '', 'ascii'))
  .digest('base64url');
if (resourceProof?.payload.ath !== expectedAth) fail('resource DPoP ath does not bind workload token');
if (resourceProof?.protected.jwk === undefined) fail('resource DPoP proof is missing public jwk');
if (thumbprint(resourceProof.protected.jwk) !== workload?.payload.cnf?.jkt) {
  fail('resource DPoP key does not match workload token cnf.jkt');
}
const resourceHtu = new URL(positive.context.resourceHtu);
if (resourceHtu.search || resourceHtu.hash) fail('resource DPoP htu must exclude query and fragment');

const negativeIds = new Set();
for (const testCase of negative.cases) {
  if (negativeIds.has(testCase.id)) fail(`duplicate negative vector id ${testCase.id}`);
  negativeIds.add(testCase.id);
  if (!vectorIds.has(testCase.source))
    fail(`${testCase.id} refers to unknown source ${testCase.source}`);
  if (!testCase.mutation || !testCase.expectedError || !testCase.stage)
    fail(`${testCase.id} is incomplete`);
}

console.log(
  `Verified ${vectorIds.size} positive signatures and ${negativeIds.size} negative case definitions.`,
);
