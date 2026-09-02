'use strict';

const { createPrivateKey, createPublicKey, createHash, sign, verify } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');

const MANIFEST_FIELDS = Object.freeze([
  'schemaVersion',
  'versionCode',
  'marketingVersion',
  'package',
  'flavor',
  'artifactUrl',
  'sha256',
  'size',
  'gitSha',
  'signatureAlgorithm',
  'keyId',
  'signature',
]);
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const ANDROID_PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_ARTIFACT_SIZE = 1024 * 1024 * 1024;

class EnterpriseUpdateManifestError extends Error {
  constructor(message) {
    super(`[M10-04] ${message}`);
    this.name = 'EnterpriseUpdateManifestError';
  }
}

function fail(message) {
  throw new EnterpriseUpdateManifestError(message);
}

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
}

function assertExactFields(value) {
  assertRecord(value, 'Enterprise update manifest');
  const actual = Object.keys(value).sort();
  const expected = [...MANIFEST_FIELDS].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail('Enterprise update manifest fields do not match schema version 1');
  }
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${field} must be a positive safe integer`);
}

function assertCanonicalBase64(value, bytes, field) {
  if (typeof value !== 'string' || !value) fail(`${field} must be canonical base64`);
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value) {
    fail(`${field} must be canonical base64 for exactly ${bytes} bytes`);
  }
  return decoded;
}

function assertArtifactUrl(value) {
  if (typeof value !== 'string') fail('artifactUrl must be a string');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('artifactUrl must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    fail('artifactUrl must be credential-free HTTPS without a fragment');
  }
}

function validateEnterpriseUpdateManifest(manifest) {
  assertExactFields(manifest);
  if (manifest.schemaVersion !== 1) fail('schemaVersion must be 1');
  assertPositiveInteger(manifest.versionCode, 'versionCode');
  if (
    typeof manifest.marketingVersion !== 'string' ||
    !SEMVER_PATTERN.test(manifest.marketingVersion)
  ) {
    fail('marketingVersion must be valid SemVer');
  }
  if (typeof manifest.package !== 'string' || !ANDROID_PACKAGE_PATTERN.test(manifest.package)) {
    fail('package must be a valid Android application ID');
  }
  if (manifest.flavor !== 'enterprise') fail('flavor must be enterprise');
  assertArtifactUrl(manifest.artifactUrl);
  if (typeof manifest.sha256 !== 'string' || !SHA256_PATTERN.test(manifest.sha256)) {
    fail('sha256 must be 64 lowercase hexadecimal characters');
  }
  assertPositiveInteger(manifest.size, 'size');
  if (manifest.size > MAX_ARTIFACT_SIZE) fail('size exceeds the updater safety limit');
  if (typeof manifest.gitSha !== 'string' || !GIT_SHA_PATTERN.test(manifest.gitSha)) {
    fail('gitSha must be a full lowercase Git SHA');
  }
  if (manifest.signatureAlgorithm !== 'Ed25519') {
    fail('signatureAlgorithm must be Ed25519');
  }
  if (typeof manifest.keyId !== 'string' || !KEY_ID_PATTERN.test(manifest.keyId)) {
    fail('keyId is invalid');
  }
  assertCanonicalBase64(manifest.signature, 64, 'signature');
  return manifest;
}

function canonicalEnterpriseUpdatePayload(manifest) {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      versionCode: manifest.versionCode,
      marketingVersion: manifest.marketingVersion,
      package: manifest.package,
      flavor: manifest.flavor,
      artifactUrl: manifest.artifactUrl,
      sha256: manifest.sha256,
      size: manifest.size,
      gitSha: manifest.gitSha,
      signatureAlgorithm: manifest.signatureAlgorithm,
      keyId: manifest.keyId,
    }),
    'utf8',
  );
}

function createEnterpriseUpdateManifest(fields, privateKey) {
  const unsigned = {
    schemaVersion: 1,
    versionCode: fields.versionCode,
    marketingVersion: fields.marketingVersion,
    package: fields.package,
    flavor: 'enterprise',
    artifactUrl: fields.artifactUrl,
    sha256: fields.sha256,
    size: fields.size,
    gitSha: fields.gitSha,
    signatureAlgorithm: 'Ed25519',
    keyId: fields.keyId,
    signature: Buffer.alloc(64).toString('base64'),
  };
  validateEnterpriseUpdateManifest(unsigned);
  const signature = sign(null, canonicalEnterpriseUpdatePayload(unsigned), privateKey);
  const manifest = { ...unsigned, signature: signature.toString('base64') };
  return validateEnterpriseUpdateManifest(manifest);
}

function verifyEnterpriseUpdateManifestSignature(manifest, publicKey) {
  validateEnterpriseUpdateManifest(manifest);
  const valid = verify(
    null,
    canonicalEnterpriseUpdatePayload(manifest),
    publicKey,
    assertCanonicalBase64(manifest.signature, 64, 'signature'),
  );
  if (!valid) fail('Enterprise update manifest signature is invalid');
  return true;
}

function assertStrictVersionAdvance(candidateVersionCode, currentVersionCode) {
  assertPositiveInteger(candidateVersionCode, 'candidate versionCode');
  if (currentVersionCode !== 0) assertPositiveInteger(currentVersionCode, 'current versionCode');
  if (candidateVersionCode <= currentVersionCode) {
    fail(
      `versionCode ${candidateVersionCode} must be strictly greater than current ${currentVersionCode}; same-version overwrite is forbidden`,
    );
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function rawEd25519PublicKey(publicKey) {
  const der = publicKey.export({ type: 'spki', format: 'der' });
  if (
    der.length !== ED25519_SPKI_PREFIX.length + 32 ||
    !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    fail('Signing key does not expose an RFC 8410 Ed25519 public key');
  }
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

function loadExternalEd25519PrivateKey(keyBytes, passphrase) {
  const privateKey = createPrivateKey({
    key: keyBytes,
    format: 'pem',
    ...(passphrase ? { passphrase } : {}),
  });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    fail('Enterprise update signing key must be Ed25519');
  }
  return privateKey;
}

function assertPublicKeyMatches(privateKey, expectedPublicKeyBase64) {
  const expected = assertCanonicalBase64(
    expectedPublicKeyBase64,
    32,
    'MOBILE_ENTERPRISE_UPDATE_PUBLIC_KEY',
  );
  const actual = rawEd25519PublicKey(createPublicKey(privateKey));
  if (!actual.equals(expected)) fail('Configured update public key does not match the signing key');
  return true;
}

function writeImmutableManifest(path, manifest) {
  validateEnterpriseUpdateManifest(manifest);
  try {
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      fail(`Refusing to overwrite existing update manifest at ${path}`);
    }
    throw error;
  }
}

module.exports = {
  EnterpriseUpdateManifestError,
  assertPublicKeyMatches,
  assertStrictVersionAdvance,
  canonicalEnterpriseUpdatePayload,
  createEnterpriseUpdateManifest,
  loadExternalEd25519PrivateKey,
  rawEd25519PublicKey,
  sha256File,
  validateEnterpriseUpdateManifest,
  verifyEnterpriseUpdateManifestSignature,
  writeImmutableManifest,
};
