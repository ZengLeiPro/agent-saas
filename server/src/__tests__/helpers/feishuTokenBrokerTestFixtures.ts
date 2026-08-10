import { FeishuOAuthClient } from '../../feishu/tokenBroker.js';
import type { VaultCaller } from '../../security/secretVault.js';

export const TEST_VAULT_READER: VaultCaller = {
  actor: 'connector_proxy',
  userId: 'user-a',
  tenantId: 'tenant-a',
  scopes: ['secret:feishu_token_bundle:read'],
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function oauth(fetchImpl: typeof fetch): FeishuOAuthClient {
  return new FeishuOAuthClient({ appId: 'cli_app', appSecret: 'server-only-secret', fetchImpl });
}
