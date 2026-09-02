import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromByteArray } from 'base64-js';
import {
  canonicalEnterpriseUpdatePayload,
  parseEnterpriseUpdateManifest,
  verifyDownloadedEnterpriseUpdate,
  verifyEnterpriseUpdateManifest,
  type EnterpriseUpdateManifest,
  type EnterpriseUpdatePolicy,
} from './enterpriseUpdateManifest';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const spki = publicKey.export({ type: 'spki', format: 'der' });
const publicKeyBase64 = spki.subarray(spki.length - 32).toString('base64');
const apk = Buffer.from('M10-04 runtime verifier synthetic APK');
const apkSha256 = createHash('sha256').update(apk).digest('hex');

function createSignedManifest(
  overrides: Partial<EnterpriseUpdateManifest> = {},
): EnterpriseUpdateManifest {
  const unsigned: EnterpriseUpdateManifest = {
    schemaVersion: 1,
    versionCode: 86,
    marketingVersion: '1.9.6',
    package: 'com.agentsaas.mobile',
    flavor: 'enterprise',
    artifactUrl: `https://updates.example.test/android/enterprise/86/${apkSha256}.apk`,
    sha256: apkSha256,
    size: apk.length,
    gitSha: '1234567890abcdef1234567890abcdef12345678',
    signatureAlgorithm: 'Ed25519',
    keyId: 'm10-04-runtime-test',
    signature: fromByteArray(new Uint8Array(64)),
    ...overrides,
  };
  return {
    ...unsigned,
    signature: sign(
      null,
      Buffer.from(canonicalEnterpriseUpdatePayload(unsigned)),
      privateKey,
    ).toString('base64'),
  };
}

function policy(overrides: Partial<EnterpriseUpdatePolicy> = {}): EnterpriseUpdatePolicy {
  return {
    expectedPackage: 'com.agentsaas.mobile',
    expectedFlavor: 'enterprise',
    installedVersionCode: 85,
    highestAcceptedVersionCode: 85,
    keyId: 'm10-04-runtime-test',
    publicKey: publicKeyBase64,
    ...overrides,
  };
}

describe('M10-04 Enterprise update client verification', () => {
  it('accepts only a valid signed manifest plus exact downloaded size and SHA-256', () => {
    const manifest = createSignedManifest();
    expect(verifyEnterpriseUpdateManifest(manifest, policy())).toEqual(manifest);
    expect(
      verifyDownloadedEnterpriseUpdate(manifest, policy(), {
        size: apk.length,
        sha256: apkSha256,
      }),
    ).toEqual(manifest);
  });

  it('rejects package and flavor mismatches before installation', () => {
    const packageMismatch = createSignedManifest({ package: 'com.other.application' });
    expect(() => verifyEnterpriseUpdateManifest(packageMismatch, policy())).toThrowError(
      expect.objectContaining({ code: 'PACKAGE_MISMATCH' }),
    );

    const flavorMismatch = createSignedManifest({ flavor: 'store' });
    expect(() => verifyEnterpriseUpdateManifest(flavorMismatch, policy())).toThrowError(
      expect.objectContaining({ code: 'FLAVOR_MISMATCH' }),
    );
  });

  it('rejects rollback and same-version replacement against installed or accepted floors', () => {
    const manifest = createSignedManifest();
    expect(() =>
      verifyEnterpriseUpdateManifest(manifest, policy({ installedVersionCode: 86 })),
    ).toThrowError(expect.objectContaining({ code: 'ROLLBACK_REJECTED' }));
    expect(() =>
      verifyEnterpriseUpdateManifest(
        manifest,
        policy({ installedVersionCode: 80, highestAcceptedVersionCode: 86 }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'ROLLBACK_REJECTED' }));
  });

  it('rejects wrong key ID, invalid signature, size mismatch, and hash mismatch', () => {
    const manifest = createSignedManifest();
    expect(() =>
      verifyEnterpriseUpdateManifest(manifest, policy({ keyId: 'rotated-key' })),
    ).toThrowError(expect.objectContaining({ code: 'KEY_ID_MISMATCH' }));

    const invalidSignature = {
      ...manifest,
      signature: fromByteArray(new Uint8Array(64).fill(9)),
    };
    expect(() => verifyEnterpriseUpdateManifest(invalidSignature, policy())).toThrowError(
      expect.objectContaining({ code: 'SIGNATURE_INVALID' }),
    );

    expect(() =>
      verifyDownloadedEnterpriseUpdate(manifest, policy(), {
        size: apk.length + 1,
        sha256: apkSha256,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SIZE_MISMATCH' }));
    expect(() =>
      verifyDownloadedEnterpriseUpdate(manifest, policy(), {
        size: apk.length,
        sha256: 'f'.repeat(64),
      }),
    ).toThrowError(expect.objectContaining({ code: 'HASH_MISMATCH' }));
  });

  it('rejects missing/extra fields and unsupported signing algorithms', () => {
    const manifest = createSignedManifest() as EnterpriseUpdateManifest & {
      mutable?: string;
    };
    manifest.mutable = 'forbidden';
    expect(() => parseEnterpriseUpdateManifest(manifest)).toThrowError(
      expect.objectContaining({ code: 'SCHEMA_INVALID' }),
    );

    const unsupported = { ...createSignedManifest(), signatureAlgorithm: 'RSA-PSS' };
    expect(() => parseEnterpriseUpdateManifest(unsupported)).toThrowError(
      expect.objectContaining({ code: 'SCHEMA_INVALID' }),
    );
  });
});
