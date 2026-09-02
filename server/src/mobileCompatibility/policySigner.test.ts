import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mobileCompatibilityPayload, type MobileCompatibilityPolicyContent } from '@agent/shared';
import { mobilePolicyAuthorityFromEnv, publicMobileCompatibilityResponse, signMobileCompatibilityPolicy } from './policySigner';

const keys = generateKeyPairSync('ed25519');
const authority = { keyId: 'mobile-policy-2026', privateKey: keys.privateKey, owner: 'mobile-oncall', approvedChangeIds: new Set(['CHG-70-02']) };
function content(overrides: Partial<MobileCompatibilityPolicyContent> = {}): MobileCompatibilityPolicyContent {
  return {
    schemaVersion: 1, tenantId: 'tenant-a', environment: 'production', appId: 'com.agentsaas.mobile',
    api: { min: 2, max: 3 }, cacheSchema: { min: 1, max: 2 }, minSupportedAppVersion: '1.9.0',
    disabledCapabilities: ['voice'], blockReason: 'INC-7002 mitigation', owner: 'mobile-oncall',
    incident: 'INC-7002', changeId: 'CHG-70-02', effectiveAt: '2026-09-01T08:00:00.000Z',
    expiresAt: '2026-09-01T10:00:00.000Z', version: 7, nonce: 'nonce-7002', ...overrides,
  };
}

describe('M70-02 server mobile compatibility signer', () => {
  it('signs a token-free, digest-bound production policy', () => {
    const signed = signMobileCompatibilityPolicy(content(), authority, Date.parse('2026-09-01T08:30:00Z'));
    expect(verify(null, Buffer.from(mobileCompatibilityPayload(signed)), keys.publicKey, Buffer.from(signed.signature, 'base64'))).toBe(true);
    expect(publicMobileCompatibilityResponse(signed)).not.toHaveProperty('token');
    expect(signMobileCompatibilityPolicy({ ...content(), token: 'secret' } as MobileCompatibilityPolicyContent, authority, Date.parse('2026-09-01T08:30:00Z'))).not.toHaveProperty('token');
  });
  it('fails closed without secret, owner or approved change', () => {
    expect(() => mobilePolicyAuthorityFromEnv({})).toThrowError(expect.objectContaining({ code: 'SIGNING_AUTHORITY_MISSING' }));
    expect(() => signMobileCompatibilityPolicy(content({ owner: 'other' }), authority, Date.parse('2026-09-01T08:30:00Z'))).toThrowError(expect.objectContaining({ code: 'PRODUCTION_OWNER_UNAPPROVED' }));
    expect(() => signMobileCompatibilityPolicy(content({ changeId: 'CHG-unapproved' }), authority, Date.parse('2026-09-01T08:30:00Z'))).toThrowError(expect.objectContaining({ code: 'PRODUCTION_CHANGE_UNAPPROVED' }));
  });
});
