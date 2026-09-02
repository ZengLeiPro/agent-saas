import jwt, { type SignOptions } from 'jsonwebtoken';
import { getEffectivePlatformCapabilities, isSuperAdmin } from '../auth/platformGovernance.js';
import type { JwtPayload } from '../auth/types.js';
import type { AuthEpochAuthority } from '../auth/authEpochAuthority.js';
import type { TenantStore } from '../data/tenants/store.js';
import { DEFAULT_TENANT_ID, DEFAULT_TENANT_SETTINGS } from '../data/tenants/types.js';
import type { UserRecord } from '../data/users/types.js';
import { isDebugModeAvailable } from '../../../shared/src/types/tenant.js';
import { buildAvatarUrl } from './authAvatar.js';

export function createAuthResponseHelpers(input: {
  tenantStore?: TenantStore;
  jwtSecret: string;
  tokenExpiresIn: string;
  authEpochAuthority?: AuthEpochAuthority;
}) {
  const tenantFeatures = (tenantId: string | undefined) =>
    input.tenantStore?.getSettings(tenantId || DEFAULT_TENANT_ID)?.features
      ?? DEFAULT_TENANT_SETTINGS.features;

  const resolveTenantName = (tenantId: string | undefined): string | undefined => {
    if (!input.tenantStore) return undefined;
    const id = tenantId || DEFAULT_TENANT_ID;
    return input.tenantStore.findById(id)?.name ?? id;
  };

  const buildAuthResponse = (user: UserRecord) => {
    const tenantId = user.tenantId || DEFAULT_TENANT_ID;
    const binding = input.authEpochAuthority?.issueLogin(user.id);
    const authPayload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      tenantId,
      platformCapabilities: user.platformCapabilities,
      platformCapabilityLimits: user.platformCapabilityLimits,
    };
    const token = jwt.sign({
      sub: user.id,
      username: user.username,
      role: user.role,
      tenantId,
      ...(binding ?? {}),
    }, input.jwtSecret, { expiresIn: input.tokenExpiresIn } as SignOptions);
    return {
      token,
      ...(binding ?? {}),
      user: {
        id: user.id,
        ...(binding ?? {}),
        username: user.username,
        role: user.role,
        tenantId,
        tenantName: resolveTenantName(tenantId),
        isSuperAdmin: isSuperAdmin(authPayload),
        platformCapabilities: getEffectivePlatformCapabilities(authPayload),
        platformCapabilityLimits: user.platformCapabilityLimits,
        realName: user.realName,
        position: user.position,
        phone: user.phone,
        phoneVerifiedAt: user.phoneVerifiedAt,
        avatar: buildAvatarUrl(user.id, user.avatar, user.avatarVersion),
        avatarVersion: user.avatarVersion,
        debugMode: user.debugMode === true
          && isDebugModeAvailable(user.tenantId, tenantFeatures(user.tenantId)),
        tenantFeatures: tenantFeatures(tenantId),
        preferences: user.preferences ?? {},
      },
    };
  };

  return { buildAuthResponse, resolveTenantName, tenantFeatures };
}
