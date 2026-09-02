import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import {
  mobileCompatibilityPayload,
  parseSignedMobileCompatibilityPolicy,
  type MobileCompatibilityPolicyContent,
  type SignedMobileCompatibilityPolicy,
} from '@agent/shared';

export interface MobilePolicySigningAuthority {
  keyId: string;
  privateKey: KeyObject;
  owner: string;
  approvedChangeIds: ReadonlySet<string>;
}

export class MobilePolicySigningError extends Error {
  constructor(readonly code: string, message = code) { super(message); this.name = 'MobilePolicySigningError'; }
}

export function mobilePolicyAuthorityFromEnv(env: NodeJS.ProcessEnv): MobilePolicySigningAuthority {
  const keyId = env.MOBILE_COMPATIBILITY_SIGNING_KEY_ID?.trim();
  const secret = env.MOBILE_COMPATIBILITY_SIGNING_PRIVATE_KEY_BASE64?.trim();
  const owner = env.MOBILE_COMPATIBILITY_POLICY_OWNER?.trim();
  const approvals = (env.MOBILE_COMPATIBILITY_APPROVED_CHANGE_IDS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  if (!keyId || !secret || !owner || approvals.length === 0) throw new MobilePolicySigningError('SIGNING_AUTHORITY_MISSING');
  try {
    return {
      keyId,
      privateKey: createPrivateKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'pkcs8' }),
      owner,
      approvedChangeIds: new Set(approvals),
    };
  } catch { throw new MobilePolicySigningError('SIGNING_SECRET_INVALID'); }
}

export function signMobileCompatibilityPolicy(
  content: MobileCompatibilityPolicyContent,
  authority: MobilePolicySigningAuthority,
  now = Date.now(),
): SignedMobileCompatibilityPolicy {
  if (content.environment === 'production') {
    if (!authority.owner || content.owner !== authority.owner) throw new MobilePolicySigningError('PRODUCTION_OWNER_UNAPPROVED');
    if (!authority.approvedChangeIds.has(content.changeId)) throw new MobilePolicySigningError('PRODUCTION_CHANGE_UNAPPROVED');
    if (!content.incident.trim() || !content.blockReason.trim()) throw new MobilePolicySigningError('PRODUCTION_AUDIT_CONTEXT_MISSING');
  }
  if (Date.parse(content.effectiveAt) > now || Date.parse(content.expiresAt) <= now) throw new MobilePolicySigningError('POLICY_TIME_WINDOW_INVALID');
  const payload = mobileCompatibilityPayload(content);
  const digest = createHash('sha256').update(payload).digest('hex');
  return parseSignedMobileCompatibilityPolicy({
    schemaVersion: content.schemaVersion,
    tenantId: content.tenantId,
    environment: content.environment,
    appId: content.appId,
    api: content.api,
    cacheSchema: content.cacheSchema,
    minSupportedAppVersion: content.minSupportedAppVersion,
    disabledCapabilities: [...content.disabledCapabilities].sort(),
    blockReason: content.blockReason,
    owner: content.owner,
    incident: content.incident,
    changeId: content.changeId,
    effectiveAt: content.effectiveAt,
    expiresAt: content.expiresAt,
    version: content.version,
    nonce: content.nonce,
    digest,
    signatureAlgorithm: 'Ed25519',
    keyId: authority.keyId,
    signature: sign(null, Buffer.from(payload), authority.privateKey).toString('base64'),
  });
}

/** Response is deliberately token-free and re-validates the exact public schema. */
export function publicMobileCompatibilityResponse(policy: SignedMobileCompatibilityPolicy): SignedMobileCompatibilityPolicy {
  return parseSignedMobileCompatibilityPolicy(policy);
}
