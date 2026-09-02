import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const {
  assertStrictVersionAdvance,
  canonicalEnterpriseUpdatePayload,
  createEnterpriseUpdateManifest,
  sha256File,
  validateEnterpriseUpdateManifest,
  verifyEnterpriseUpdateManifestSignature,
  writeImmutableManifest,
} = require('./enterprise-update-manifest.cjs');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const APK_BYTES = Buffer.from('M10-04 synthetic APK test bytes');
const SHA256 = createHash('sha256').update(APK_BYTES).digest('hex');

function signedManifest(overrides = {}) {
  return createEnterpriseUpdateManifest(
    {
      versionCode: 86,
      marketingVersion: '1.9.6',
      package: 'com.agentsaas.mobile',
      artifactUrl: `https://updates.example.test/android/enterprise/86/1234567890abcdef1234567890abcdef12345678/${SHA256}.apk`,
      sha256: SHA256,
      size: APK_BYTES.length,
      gitSha: '1234567890abcdef1234567890abcdef12345678',
      keyId: 'm10-04-test-key',
      ...overrides,
    },
    privateKey,
  );
}

test('M10-04 signed Enterprise manifest has the complete immutable contract', () => {
  const manifest = signedManifest();
  assert.equal(validateEnterpriseUpdateManifest(manifest), manifest);
  assert.equal(verifyEnterpriseUpdateManifestSignature(manifest, publicKey), true);
  assert.deepEqual(Object.keys(manifest), [
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
  const canonical = canonicalEnterpriseUpdatePayload(manifest).toString('utf8');
  assert.match(canonical, /"signatureAlgorithm":"Ed25519"/);
  assert.match(canonical, /"keyId":"m10-04-test-key"/);
  assert.doesNotMatch(canonical, /"signature":/);
});

test('M10-04 schema and signature reject hash, algorithm, package, flavor, and signature tampering', () => {
  const manifest = signedManifest();
  for (const [field, value, expected] of [
    ['sha256', 'f'.repeat(64), /signature is invalid/],
    ['package', 'com.attacker.app', /signature is invalid/],
    ['signature', Buffer.alloc(64, 7).toString('base64'), /signature is invalid/],
    ['flavor', 'store', /flavor must be enterprise/],
    ['signatureAlgorithm', 'RSA-PSS', /signatureAlgorithm must be Ed25519/],
  ]) {
    const tampered = { ...manifest, [field]: value };
    assert.throws(
      () => verifyEnterpriseUpdateManifestSignature(tampered, publicKey),
      expected,
      field,
    );
  }

  const missing = { ...manifest };
  delete missing.size;
  assert.throws(() => validateEnterpriseUpdateManifest(missing), /fields do not match schema/);
  const unexpected = { ...manifest, buildTime: 'mutable' };
  assert.throws(() => validateEnterpriseUpdateManifest(unexpected), /fields do not match schema/);
});

test('M10-04 artifact SHA-256 is content-derived and same version cannot advance', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'm10-04-manifest-'));
  try {
    const apkPath = resolve(directory, 'fixture.apk');
    writeFileSync(apkPath, APK_BYTES);
    assert.equal(sha256File(apkPath), SHA256);
    assert.doesNotThrow(() => assertStrictVersionAdvance(86, 85));
    assert.throws(() => assertStrictVersionAdvance(86, 86), /same-version overwrite is forbidden/);
    assert.throws(() => assertStrictVersionAdvance(85, 86), /strictly greater/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('M10-04 immutable manifest writer refuses a same-path overwrite', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'm10-04-immutable-'));
  try {
    const output = resolve(directory, '86.json');
    const manifest = signedManifest();
    writeImmutableManifest(output, manifest);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), manifest);
    assert.throws(() => writeImmutableManifest(output, manifest), /Refusing to overwrite/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('M10-04 signing code accepts private key material only from external runtime input', () => {
  const prepare = readFileSync(resolve(HERE, 'prepare-enterprise-update.mjs'), 'utf8');
  assert.match(prepare, /ENTERPRISE_UPDATE_SIGNING_PRIVATE_KEY_PATH/);
  assert.match(prepare, /must remain outside the repository/);
  assert.match(prepare, /ENTERPRISE_UPDATE_SIGNING_KEY_PASSPHRASE/);
  assert.match(prepare, /ANDROID_APK_ANALYZER_PATH/);
  assert.match(prepare, /application-id/);
  assert.match(prepare, /version-code/);
  assert.doesNotMatch(prepare, /BEGIN (?:ENCRYPTED )?PRIVATE KEY/);
  assert.match(prepare, /version-name/);
  assert.doesNotMatch(prepare, /console\.(?:log|error).*SIGNING_PRIVATE_KEY_PATH/);
});
