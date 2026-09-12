import { InMemorySecretVault } from '../security/secretVault.js';
import {
  GrokCredentialManager,
  type GrokSubscriptionRuntimeConfig,
} from '../runtime/responses/grokCredentialManager.js';
import { GrokOAuthClient, type GrokOAuthTokens } from '../runtime/responses/grokOAuthClient.js';
import { GROK_OAUTH_ISSUER } from '../runtime/responses/grokProtocol.js';
import { InMemorySubscriptionCredentialRuntimeStateStore } from '../runtime/responses/subscriptionCredentialRuntimeState.js';
import { InMemorySubscriptionRefreshJournal } from '../runtime/responses/subscriptionRefreshJournal.js';
export function grokTokens(accountId = 'fixture-a', ttlMs = 3_600_000): GrokOAuthTokens {
  return {
    accessToken: `fixture-access-${accountId}`,
    refreshToken: `fixture-refresh-${accountId}`,
    accountId,
    issuer: GROK_OAUTH_ISSUER,
    clientId: 'fixture-client',
    email: `${accountId}@example.invalid`,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}
export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
export async function grokFixture(count = 2) {
  const vault = new InMemorySecretVault();
  const config: GrokSubscriptionRuntimeConfig = {
    enabled: true,
    credentialRefs: [],
    quotaCooldownMinutes: 60,
  };
  const state = new InMemorySubscriptionCredentialRuntimeStateStore();
  const journal = new InMemorySubscriptionRefreshJournal();
  const oauth = new GrokOAuthClient();
  const manager = new GrokCredentialManager({
    vault,
    getConfig: () => config,
    runtimeStateStore: state,
    refreshJournal: journal,
    oauthClient: oauth,
  });
  const refs: string[] = [];
  for (let i = 0; i < count; i += 1)
    refs.push((await manager.persistLogin(grokTokens(`fixture-${i}`))).credentialRef);
  config.credentialRefs = [...refs];
  config.credentialRef = refs[0];
  return { vault, config, state, journal, oauth, manager, refs };
}
