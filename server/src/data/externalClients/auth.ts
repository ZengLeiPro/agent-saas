import { createHash, randomBytes } from 'node:crypto';

import { checkTenantAccess } from '../tenants/access.js';
import type { TenantStore } from '../tenants/store.js';
import type { UserStore } from '../users/store.js';
import type { ExternalClientRecord, ExternalClientStore } from './types.js';

const API_KEY_PREFIX = 'ky_ext_';

export interface ExternalApiKeyMaterial {
  apiKey: string;
  keyHash: string;
  keyPrefix: string;
}

export interface ExternalClientPrincipal {
  client: ExternalClientRecord;
  tenantId: string;
  serviceAccountUserId: string;
  username: string;
}

export type ExternalClientAuthenticationResult =
  | { ok: true; principal: ExternalClientPrincipal }
  | { ok: false; status: 401 | 403 | 409; code: string };

export function hashExternalApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex');
}

export function generateExternalApiKey(): ExternalApiKeyMaterial {
  const apiKey = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    apiKey,
    keyHash: hashExternalApiKey(apiKey),
    keyPrefix: apiKey.slice(0, 18),
  };
}

export class ExternalClientAuthenticator {
  constructor(
    private readonly deps: {
      store: ExternalClientStore;
      userStore: UserStore;
      tenantStore?: TenantStore;
    },
  ) {}

  async authenticateBearer(
    authorization: string | undefined,
  ): Promise<ExternalClientAuthenticationResult> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization?.trim() ?? '');
    const apiKey = match?.[1];
    if (!apiKey?.startsWith(API_KEY_PREFIX))
      return { ok: false, status: 401, code: 'invalid_api_key' };

    const client = await this.deps.store.findByKeyHash(hashExternalApiKey(apiKey));
    if (!client || client.status !== 'active')
      return { ok: false, status: 401, code: 'invalid_api_key' };
    if (client.expiresAt && new Date(client.expiresAt).getTime() <= Date.now()) {
      return { ok: false, status: 401, code: 'api_key_expired' };
    }

    const user = this.deps.userStore.findById(client.serviceAccountUserId);
    if (!user || user.disabled || user.role !== 'user' || user.tenantId !== client.tenantId) {
      return { ok: false, status: 403, code: 'account_disabled' };
    }
    const tenantAccess = checkTenantAccess(this.deps.tenantStore, client.tenantId);
    if (!tenantAccess.ok) return { ok: false, status: 403, code: 'tenant_unavailable' };
    if (
      this.deps.tenantStore?.getSettings(client.tenantId)?.features.personalAgentEnabled === false
    ) {
      return { ok: false, status: 409, code: 'personal_agent_unavailable' };
    }

    await this.deps.store.touchLastUsed(client.clientId, new Date().toISOString());
    return {
      ok: true,
      principal: {
        client,
        tenantId: client.tenantId,
        serviceAccountUserId: client.serviceAccountUserId,
        username: user.username,
      },
    };
  }
}
