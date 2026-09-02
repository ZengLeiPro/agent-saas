import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';
import { utf8ToBytes } from '@noble/hashes/utils';
import { fromByteArray, toByteArray } from 'base64-js';

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
] as const);
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const ANDROID_PACKAGE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_ARTIFACT_SIZE = 1024 * 1024 * 1024;

// @noble/ed25519 v2 deliberately delegates SHA-512. A synchronous pure-JS
// implementation keeps verification available in Hermes without WebCrypto.
ed25519.etc.sha512Sync = (...messages: Uint8Array[]) =>
  sha512(ed25519.etc.concatBytes(...messages));

export type EnterpriseUpdateFailureCode =
  | 'SCHEMA_INVALID'
  | 'PACKAGE_MISMATCH'
  | 'FLAVOR_MISMATCH'
  | 'ROLLBACK_REJECTED'
  | 'KEY_ID_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'SIZE_MISMATCH'
  | 'HASH_MISMATCH';

export class EnterpriseUpdateVerificationError extends Error {
  constructor(
    readonly code: EnterpriseUpdateFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'EnterpriseUpdateVerificationError';
  }
}

export interface EnterpriseUpdateManifest {
  schemaVersion: 1;
  versionCode: number;
  marketingVersion: string;
  package: string;
  flavor: 'store' | 'enterprise';
  artifactUrl: string;
  sha256: string;
  size: number;
  gitSha: string;
  signatureAlgorithm: 'Ed25519';
  keyId: string;
  signature: string;
}

export interface EnterpriseUpdatePolicy {
  expectedPackage: string;
  expectedFlavor: 'enterprise';
  installedVersionCode: number;
  highestAcceptedVersionCode: number;
  keyId: string;
  publicKey: string;
}

function schemaFailure(message: string): never {
  throw new EnterpriseUpdateVerificationError('SCHEMA_INVALID', message);
}

function assertRecord(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    schemaFailure('Enterprise update manifest must be an object');
  }
}

function assertExactFields(value: Record<string, unknown>): void {
  const actual = Object.keys(value).sort();
  const expected = [...MANIFEST_FIELDS].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    schemaFailure('Enterprise update manifest fields do not match schema version 1');
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    schemaFailure(`${field} must be a positive safe integer`);
  }
}

function assertCanonicalBase64(value: unknown, bytes: number, field: string): string {
  if (typeof value !== 'string' || !value) schemaFailure(`${field} must be base64`);
  let decoded: Uint8Array;
  try {
    decoded = toByteArray(value);
  } catch {
    schemaFailure(`${field} must be canonical base64`);
  }
  if (decoded.length !== bytes || fromByteArray(decoded) !== value) {
    schemaFailure(`${field} must be canonical base64 for exactly ${bytes} bytes`);
  }
  return value;
}

function assertArtifactUrl(value: unknown): asserts value is string {
  if (typeof value !== 'string') schemaFailure('artifactUrl must be a string');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    schemaFailure('artifactUrl must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    schemaFailure('artifactUrl must be credential-free HTTPS without a fragment');
  }
}

export function parseEnterpriseUpdateManifest(value: unknown): EnterpriseUpdateManifest {
  assertRecord(value);
  assertExactFields(value);
  if (value.schemaVersion !== 1) schemaFailure('schemaVersion must be 1');
  assertPositiveInteger(value.versionCode, 'versionCode');
  if (typeof value.marketingVersion !== 'string' || !SEMVER_PATTERN.test(value.marketingVersion)) {
    schemaFailure('marketingVersion must be valid SemVer');
  }
  if (typeof value.package !== 'string' || !ANDROID_PACKAGE_PATTERN.test(value.package)) {
    schemaFailure('package must be a valid Android application ID');
  }
  if (value.flavor !== 'store' && value.flavor !== 'enterprise') {
    schemaFailure('flavor must be store or enterprise');
  }
  assertArtifactUrl(value.artifactUrl);
  if (typeof value.sha256 !== 'string' || !SHA256_PATTERN.test(value.sha256)) {
    schemaFailure('sha256 must be 64 lowercase hexadecimal characters');
  }
  assertPositiveInteger(value.size, 'size');
  if (value.size > MAX_ARTIFACT_SIZE) schemaFailure('size exceeds the updater safety limit');
  if (typeof value.gitSha !== 'string' || !GIT_SHA_PATTERN.test(value.gitSha)) {
    schemaFailure('gitSha must be a full lowercase Git SHA');
  }
  if (value.signatureAlgorithm !== 'Ed25519') {
    schemaFailure('signatureAlgorithm must be Ed25519');
  }
  if (typeof value.keyId !== 'string' || !KEY_ID_PATTERN.test(value.keyId)) {
    schemaFailure('keyId is invalid');
  }
  assertCanonicalBase64(value.signature, 64, 'signature');
  return value as unknown as EnterpriseUpdateManifest;
}

export function canonicalEnterpriseUpdatePayload(manifest: EnterpriseUpdateManifest): Uint8Array {
  return utf8ToBytes(
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
  );
}

export function assertStrictVersionAdvance(
  candidateVersionCode: number,
  installedVersionCode: number,
  highestAcceptedVersionCode: number,
): void {
  const floor = Math.max(installedVersionCode, highestAcceptedVersionCode);
  if (candidateVersionCode <= floor) {
    throw new EnterpriseUpdateVerificationError(
      'ROLLBACK_REJECTED',
      `versionCode ${candidateVersionCode} must be greater than trusted floor ${floor}`,
    );
  }
}

export function verifyEnterpriseUpdateManifest(
  value: unknown,
  policy: EnterpriseUpdatePolicy,
): EnterpriseUpdateManifest {
  const manifest = parseEnterpriseUpdateManifest(value);
  if (manifest.package !== policy.expectedPackage) {
    throw new EnterpriseUpdateVerificationError(
      'PACKAGE_MISMATCH',
      'Update package does not match the installed application',
    );
  }
  if (manifest.flavor !== policy.expectedFlavor) {
    throw new EnterpriseUpdateVerificationError(
      'FLAVOR_MISMATCH',
      'Update flavor does not match this application distribution',
    );
  }
  assertStrictVersionAdvance(
    manifest.versionCode,
    policy.installedVersionCode,
    policy.highestAcceptedVersionCode,
  );
  if (manifest.keyId !== policy.keyId) {
    throw new EnterpriseUpdateVerificationError(
      'KEY_ID_MISMATCH',
      'Update signing key ID does not match the configured key',
    );
  }

  const publicKey = assertCanonicalBase64(policy.publicKey, 32, 'configured public key');
  const signature = assertCanonicalBase64(manifest.signature, 64, 'signature');
  let valid = false;
  try {
    valid = ed25519.verify(
      toByteArray(signature),
      canonicalEnterpriseUpdatePayload(manifest),
      toByteArray(publicKey),
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new EnterpriseUpdateVerificationError(
      'SIGNATURE_INVALID',
      'Enterprise update manifest signature is invalid',
    );
  }
  return manifest;
}

export function verifyDownloadedEnterpriseUpdate(
  value: unknown,
  policy: EnterpriseUpdatePolicy,
  downloaded: { size: number; sha256: string },
): EnterpriseUpdateManifest {
  const manifest = verifyEnterpriseUpdateManifest(value, policy);
  if (downloaded.size !== manifest.size) {
    throw new EnterpriseUpdateVerificationError(
      'SIZE_MISMATCH',
      'Downloaded APK size does not match the signed manifest',
    );
  }
  if (downloaded.sha256 !== manifest.sha256) {
    throw new EnterpriseUpdateVerificationError(
      'HASH_MISMATCH',
      'Downloaded APK SHA-256 does not match the signed manifest',
    );
  }
  return manifest;
}
