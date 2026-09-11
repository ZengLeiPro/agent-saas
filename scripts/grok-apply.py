from pathlib import Path
import re
r = Path('server/src/runtime/responses')
def put(name, text):
    (r / name).write_text(text.lstrip('\n'))
# Provider-neutral implementation, retaining Codex compatibility imports and old SQL names.
p = r / 'codexCredentialRuntimeState.ts'
s = p.read_text().replace('CodexCredential', 'SubscriptionCredential')
s = s.replace("config: { backend: string; tablePrefix?: string } | undefined,\n)", "config: { backend: string; tablePrefix?: string } | undefined,\n  provider: 'codex' | 'grok' = 'codex',\n)")
s = s.replace("config?.backend === 'pg' ? (config.tablePrefix ?? 'runtime') : 'runtime',\n  );", "config?.backend === 'pg' ? (config.tablePrefix ?? 'runtime') : 'runtime',\n    provider,\n  );")
s = s.replace("tablePrefix = 'runtime',\n  ) {\n    this.table = `${sanitizeIdentifier(tablePrefix)}_codex_credential_runtime_state`;", "tablePrefix = 'runtime',\n    provider: 'codex' | 'grok' = 'codex',\n  ) {\n    if (provider !== 'codex' && provider !== 'grok') throw new Error('Unknown subscription provider');\n    this.table = `${sanitizeIdentifier(tablePrefix)}_${provider}_credential_runtime_state`;")
put('subscriptionCredentialRuntimeState.ts', s)
put('codexCredentialRuntimeState.ts', '''/** Compatibility entry point: Codex imports and SQL names remain unchanged. */
export {
  InMemorySubscriptionCredentialRuntimeStateStore as InMemoryCodexCredentialRuntimeStateStore,
  PgSubscriptionCredentialRuntimeStateStore as PgCodexCredentialRuntimeStateStore,
  createSubscriptionCredentialRuntimeStateStore as createCodexCredentialRuntimeStateStore,
  type SubscriptionCredentialAvailability as CodexCredentialAvailability,
  type SubscriptionCredentialRuntimeState as CodexCredentialRuntimeState,
  type SubscriptionCredentialRuntimeStateStore as CodexCredentialRuntimeStateStore,
} from './subscriptionCredentialRuntimeState.js';
''')
p = r / 'codexCredentialManager.ts'; s = p.read_text()
a = s.index('export interface CodexCredentialLock'); b = s.index('export class CodexCredentialManager', a)
put('subscriptionCredentialLock.ts', s[a:b].replace('CodexCredentialLock', 'SubscriptionCredentialLock'))
s = s[:a] + s[b:]
s = '''import { LocalSubscriptionCredentialLock as LocalCodexCredentialLock, type SubscriptionCredentialLock as CodexCredentialLock } from './subscriptionCredentialLock.js';
export { LocalSubscriptionCredentialLock as LocalCodexCredentialLock, PgSubscriptionCredentialLock as PgCodexCredentialLock, type SubscriptionCredentialLock as CodexCredentialLock, type PgLockPool } from './subscriptionCredentialLock.js';
''' + s
s = s.replace("import { createHash } from 'node:crypto';", "import { hashAccountBinding, orderedCredentialRefs } from './subscriptionAccountBinding.js';\nexport { hashAccountBinding } from './subscriptionAccountBinding.js';")
a = s.index('    const raw = this.options.getConfig() ?? {};', s.index('  getCredentialRefs():')); b = s.index('\n  }', a)
s = s[:a] + '    return orderedCredentialRefs(this.options.getConfig());' + s[b:]
a = s.index('export function hashAccountBinding('); b = s.index('\n}', a) + 2
s = s[:a] + s[b:]; p.write_text(s)
put('subscriptionAccountBinding.ts', '''import { createHash } from 'node:crypto';
export function hashAccountBinding(accountId: string): string {
  return createHash('sha256').update(accountId).digest('hex').slice(0, 32);
}
export function orderedCredentialRefs(config: { credentialRef?: string; credentialRefs?: string[] } | undefined): string[] {
  const refs = config?.credentialRefs?.length ? config.credentialRefs : config?.credentialRef ? [config.credentialRef] : [];
  return [...new Set(refs.filter((ref) => typeof ref === 'string' && ref.trim().length > 0))];
}
''')
p = r / 'codexSubscriptionTelemetry.ts'; s = p.read_text()
put('subscriptionTelemetry.ts', s.replace('CodexSubscription', 'Subscription').replace('CodexWireRequestSample', 'SubscriptionWireRequestSample'))
lines = []
for name in re.findall(r'export (?:interface|type|class|function) (\w+)', s):
    new = name.replace('CodexSubscription', 'Subscription').replace('CodexWireRequestSample', 'SubscriptionWireRequestSample')
    prefix = '' if f'export class {name}' in s or f'export function {name}' in s else 'type '
    lines.append(f'  {prefix}{new} as {name},')
p.write_text("/** Compatibility aliases for provider-neutral diagnostics. */\nexport {\n" + '\n'.join(lines) + "\n} from './subscriptionTelemetry.js';\n")
put('orderedSubscriptionFailover.ts', '''import type { SubscriptionCredentialRuntimeState } from './subscriptionCredentialRuntimeState.js';
export type SubscriptionAttempt<Result, Quota> =
  | { kind: 'result'; result: Result }
  | { kind: 'quota'; quota: Quota; cooldownUntil: string }
  | { kind: 'auth_unavailable' }
  | { kind: 'ineligible' };
/** Shared priority scheduling. Only provider policy may classify quota/auth failures. */
export async function executeOrderedSubscriptionFailover<Token, Result, Quota>(options: {
  credentialRefs: readonly string[];
  signal?: AbortSignal;
  isConfigured?: (ref: string) => boolean;
  getRuntimeState: (ref: string) => Promise<SubscriptionCredentialRuntimeState | undefined>;
  getCredentials: (ref: string) => Promise<Token>;
  handleCredentialError: (ref: string, error: unknown) => Promise<boolean>;
  attempt: (ref: string, token: Token) => Promise<SubscriptionAttempt<Result, Quota>>;
  disposeQuota: (quota: Quota | undefined) => Promise<void>;
  finishQuota: (quota: Quota, retryAt: string) => Promise<Result>;
  finishUnavailable: (state: { earliestCooldownUntil?: string; authUnavailableCount: number; accountCount: number; ineligibleCount: number }) => Result | Promise<Result>;
}): Promise<Result> {
  let lastQuota: Quota | undefined;
  let retainLastQuota = false;
  let earliestCooldownUntil: string | undefined;
  let authUnavailableCount = 0;
  let ineligibleCount = 0;
  const observeCooldown = (until?: string) => {
    if (until && (!earliestCooldownUntil || until < earliestCooldownUntil)) earliestCooldownUntil = until;
  };
  try {
    for (const ref of options.credentialRefs) {
      options.signal?.throwIfAborted();
      if (options.isConfigured && !options.isConfigured(ref)) { ineligibleCount += 1; continue; }
      const state = await options.getRuntimeState(ref);
      if (state?.availability === 'quota_cooldown') { observeCooldown(state.cooldownUntil); continue; }
      if (state?.availability === 'auth_unavailable') { authUnavailableCount += 1; continue; }
      let token: Token;
      try { token = await options.getCredentials(ref); }
      catch (error) {
        options.signal?.throwIfAborted();
        if (!await options.handleCredentialError(ref, error)) throw error;
        authUnavailableCount += 1; continue;
      }
      options.signal?.throwIfAborted();
      if (options.isConfigured && !options.isConfigured(ref)) { ineligibleCount += 1; continue; }
      const outcome = await options.attempt(ref, token);
      if (outcome.kind === 'result') return outcome.result;
      if (outcome.kind === 'auth_unavailable') { authUnavailableCount += 1; continue; }
      if (outcome.kind === 'ineligible') { ineligibleCount += 1; continue; }
      observeCooldown(outcome.cooldownUntil);
      await options.disposeQuota(lastQuota); lastQuota = outcome.quota;
    }
    options.signal?.throwIfAborted();
    if (lastQuota !== undefined) {
      const result = await options.finishQuota(lastQuota, earliestCooldownUntil ?? new Date().toISOString());
      retainLastQuota = true; return result;
    }
    return options.finishUnavailable({ earliestCooldownUntil, authUnavailableCount, ineligibleCount, accountCount: options.credentialRefs.length });
  } finally { if (!retainLastQuota) await options.disposeQuota(lastQuota); }
}
''')
p = r / 'codexCredentialFailover.ts'; s = p.read_text(); a = s.index('  let lastQuota: LastQuota | undefined;'); b = s.index('\nasync function getRuntimeState', a)
s = s[:a] + '''  return executeOrderedSubscriptionFailover({
    credentialRefs: input.credentialRefs, signal: input.request.signal,
    getRuntimeState: (ref) => getRuntimeState(input.credentials, ref),
    getCredentials: (ref) => getCredentialsForCredential(input.credentials, ref),
    handleCredentialError: async (ref, error) => {
      if (!isPermanentCredentialError(error)) return false;
      await markAuthUnavailable(input.credentials, ref, credentialFailureCode(error), await resolveCredentialFailureGeneration(input.credentials, ref, error));
      return true;
    },
    attempt: async (credentialRef, token) => {
      try {
        const result = await input.executeWithCredential(token);
        if (input.request.recoveryAttempt) return { kind: 'result', result };
        const quotaCode = await codexQuotaResponseCode(result.response);
        if (!quotaCode) return { kind: 'result', result };
        let cooldownUntil: string;
        try { cooldownUntil = await markQuotaCooldown(input.credentials, credentialRef, quotaCode, token.generation); }
        catch (error) { await result.response.body?.cancel().catch(() => undefined); throw error; }
        return { kind: 'quota', quota: { kind: 'response', result } as LastQuota, cooldownUntil };
      } catch (error) {
        if (isCodexQuotaTransportError(error)) {
          if (input.request.recoveryAttempt || input.request.signal?.aborted) throw error;
          const cooldownUntil = await markQuotaCooldown(input.credentials, credentialRef, error.code, token.generation);
          return { kind: 'quota', quota: { kind: 'transport_error', accountId: token.accountId, error } as LastQuota, cooldownUntil };
        }
        if (error instanceof CodexAccountAuthUnavailableError) {
          if (input.request.recoveryAttempt || input.request.signal?.aborted) throw error;
          await markAuthUnavailable(input.credentials, credentialRef, error.code, error.credentialGeneration);
          return { kind: 'auth_unavailable' };
        }
        throw error;
      }
    },
    disposeQuota: cancelQuotaResponse,
    finishQuota: async (lastQuota, retryAt) => lastQuota.kind === 'response'
      ? quotaResponseResult(lastQuota.result, retryAt)
      : quotaErrorResult(input.request, lastQuota.accountId, lastQuota.error, retryAt, input.credentials.getConfiguration().endpoint),
    finishUnavailable: (state) => unavailableAccountsResult(input.request, state),
  });
}
''' + s[b:]
p.write_text("import { executeOrderedSubscriptionFailover } from './orderedSubscriptionFailover.js';\n" + s)
put('grokProtocol.ts', r'''/** xAI subscription protocol. No Console/API-key fallback. */
export const GROK_OAUTH_ISSUER = 'https://auth.x.ai';
export const GROK_DISCOVERY_ENDPOINT = `${GROK_OAUTH_ISSUER}/.well-known/openid-configuration`;
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
export const GROK_SUBSCRIPTION_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';
export const GROK_RESPONSES_ENDPOINT = `${GROK_SUBSCRIPTION_BASE_URL}/responses`;
export const GROK_MODELS_ENDPOINT = `${GROK_SUBSCRIPTION_BASE_URL}/models`;
export const GROK_BILLING_ENDPOINT = `${GROK_SUBSCRIPTION_BASE_URL}/billing?format=credits`;
export const GROK_DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const OAUTH_ERRORS = new Set(['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant', 'invalid_token', 'invalid_client', 'invalid_scope', 'unauthorized_client', 'unsupported_grant_type', 'temporarily_unavailable', 'server_error']);
/** Only locally selected codes enter diagnostics; upstream bodies may contain secrets. */
export class GrokProtocolError extends Error {
  constructor(readonly code: string, readonly status?: number, readonly outcomeUnknown = false) {
    super(`Grok ${code}${status === undefined ? '' : ` (HTTP ${status})`}`); this.name = 'GrokProtocolError';
  }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function trustedGrokOAuthUrl(value: unknown, verification = false): string {
  if (typeof value !== 'string') throw new GrokProtocolError('untrusted_oauth_endpoint');
  let url: URL;
  try { url = new URL(value); } catch { throw new GrokProtocolError('untrusted_oauth_endpoint'); }
  const hosts = verification ? ['auth.x.ai', 'accounts.x.ai', 'x.ai'] : ['auth.x.ai'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password || url.hash) throw new GrokProtocolError('untrusted_oauth_endpoint');
  return url.href;
}
export function validateGrokEndpoint(value: string): string {
  if (value !== GROK_RESPONSES_ENDPOINT) throw new GrokProtocolError('untrusted_subscription_endpoint');
  return value;
}
export function subscriptionHeaders(token: string, model?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'agent-saas/1.0',
    'x-grok-client-mode': 'cli', 'x-grok-client-version': '1.0.4',
    ...(model ? { 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-grok-model-override': model } : {}),
  };
}
export function positiveSeconds(value: unknown, max = 31_536_000): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max) throw new GrokProtocolError('invalid_expiration');
  return value;
}
export function requiredString(value: unknown, max = 32_768): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new GrokProtocolError('invalid_response_field');
  return value;
}
export async function readGrokJson(response: Response, maxBytes = 128 * 1024): Promise<unknown> {
  if (!/application\/(?:[\w.+-]+\+)?json\b/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => undefined);
    throw new GrokProtocolError('non_json_or_challenge', response.status, response.ok || response.status >= 500);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GrokProtocolError('empty_response', response.status, response.ok);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new GrokProtocolError('response_too_large', response.status, response.ok);
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new GrokProtocolError('invalid_json', response.status, response.ok); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export async function grokOAuthRequest(fetchImpl: typeof fetch, url: string, body?: Record<string, string>, signal?: AbortSignal, accessToken?: string): Promise<unknown> {
  trustedGrokOAuthUrl(url);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { Accept: 'application/json', 'User-Agent': 'agent-saas/1.0', ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
      ...(body ? { body: new URLSearchParams(body).toString() } : {}),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
  } catch { signal?.throwIfAborted(); throw new GrokProtocolError('network_outcome_unknown', undefined, true); }
  const json = await readGrokJson(response);
  if (!response.ok) {
    const code = isRecord(json) && typeof json.error === 'string' && OAUTH_ERRORS.has(json.error) ? json.error : 'upstream_error';
    throw new GrokProtocolError(code, response.status, response.status >= 500);
  }
  return json;
}
''')
put('grokOAuthClient.ts', '''import { GROK_DEVICE_GRANT, GROK_DISCOVERY_ENDPOINT, GROK_OAUTH_CLIENT_ID, GROK_OAUTH_ISSUER, GROK_OAUTH_SCOPE, GrokProtocolError, grokOAuthRequest, isRecord, positiveSeconds, requiredString, trustedGrokOAuthUrl } from './grokProtocol.js';
export interface GrokOAuthTokens {
  accessToken: string; refreshToken: string; idToken?: string; expiresAt: string;
  accountId: string; email?: string; issuer: typeof GROK_OAUTH_ISSUER; clientId: string;
}
export interface GrokDiscovery { deviceEndpoint: string; tokenEndpoint: string; userinfoEndpoint: string; revocationEndpoint?: string }
export interface GrokDeviceCode { deviceCode: string; userCode: string; verificationUri: string; intervalMs: number; expiresAt: number; clientId: string }
export class GrokOAuthClient {
  private discovery?: { value: GrokDiscovery; expiresAt: number };
  private discoveryInFlight?: Promise<GrokDiscovery>;
  constructor(private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}
  async discover(): Promise<GrokDiscovery> {
    if (this.discovery && this.discovery.expiresAt > this.now()) return this.discovery.value;
    if (this.discoveryInFlight) return this.discoveryInFlight;
    const promise = (async () => {
      const raw = await grokOAuthRequest(this.fetchImpl, GROK_DISCOVERY_ENDPOINT);
      if (!isRecord(raw) || raw.issuer !== GROK_OAUTH_ISSUER) throw new GrokProtocolError('invalid_issuer');
      const value: GrokDiscovery = {
        deviceEndpoint: trustedGrokOAuthUrl(raw.device_authorization_endpoint), tokenEndpoint: trustedGrokOAuthUrl(raw.token_endpoint),
        userinfoEndpoint: trustedGrokOAuthUrl(raw.userinfo_endpoint), ...(raw.revocation_endpoint ? { revocationEndpoint: trustedGrokOAuthUrl(raw.revocation_endpoint) } : {}),
      };
      this.discovery = { value, expiresAt: this.now() + 300_000 }; return value;
    })().finally(() => { if (this.discoveryInFlight === promise) this.discoveryInFlight = undefined; });
    this.discoveryInFlight = promise; return promise;
  }
  async start(clientId = GROK_OAUTH_CLIENT_ID): Promise<GrokDeviceCode> {
    requiredString(clientId, 256);
    const discovery = await this.discover();
    const raw = await grokOAuthRequest(this.fetchImpl, discovery.deviceEndpoint, { client_id: clientId, scope: GROK_OAUTH_SCOPE });
    if (!isRecord(raw)) throw new GrokProtocolError('invalid_device_response');
    return { deviceCode: requiredString(raw.device_code), userCode: requiredString(raw.user_code, 128),
      verificationUri: trustedGrokOAuthUrl(raw.verification_uri_complete ?? raw.verification_uri, true),
      intervalMs: positiveSeconds(raw.interval ?? 5, 300) * 1_000, expiresAt: this.now() + positiveSeconds(raw.expires_in, 86_400) * 1_000, clientId };
  }
  async poll(device: GrokDeviceCode): Promise<GrokOAuthTokens> {
    const discovery = await this.discover();
    const raw = await grokOAuthRequest(this.fetchImpl, discovery.tokenEndpoint, { grant_type: GROK_DEVICE_GRANT, device_code: device.deviceCode, client_id: device.clientId });
    return this.validateTokens(raw, device.clientId, discovery);
  }
  async refresh(previous: GrokOAuthTokens): Promise<GrokOAuthTokens> {
    if (previous.issuer !== GROK_OAUTH_ISSUER) throw new GrokProtocolError('invalid_issuer');
    const discovery = await this.discover();
    // One exchange only: a lost response may have consumed the rotating grant.
    const raw = await grokOAuthRequest(this.fetchImpl, discovery.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: previous.refreshToken, client_id: previous.clientId });
    try {
      const tokens = await this.validateTokens(raw, previous.clientId, discovery, previous.refreshToken);
      if (tokens.accountId !== previous.accountId) throw new GrokProtocolError('identity_changed', undefined, true);
      return tokens;
    } catch (error) { throw new GrokProtocolError(error instanceof GrokProtocolError ? error.code : 'invalid_token_response', undefined, true); }
  }
  async revoke(tokens: GrokOAuthTokens): Promise<boolean> {
    const { revocationEndpoint } = await this.discover(); if (!revocationEndpoint) return false;
    const response = await this.fetchImpl(revocationEndpoint, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ token: tokens.refreshToken, token_type_hint: 'refresh_token', client_id: tokens.clientId }).toString(), signal: AbortSignal.timeout(15_000) });
    await response.body?.cancel().catch(() => undefined); return response.ok;
  }
  private async validateTokens(raw: unknown, clientId: string, discovery: GrokDiscovery, previousRefreshToken?: string): Promise<GrokOAuthTokens> {
    if (!isRecord(raw)) throw new GrokProtocolError('invalid_token_response');
    if (raw.token_type !== undefined && String(raw.token_type).toLowerCase() !== 'bearer') throw new GrokProtocolError('unsupported_token_type');
    const accessToken = requiredString(raw.access_token); const refreshToken = requiredString(raw.refresh_token ?? previousRefreshToken);
    const expiresAt = new Date(this.now() + positiveSeconds(raw.expires_in) * 1_000).toISOString();
    // Identity is authenticated userinfo, not frontend input or an unverified JWT.
    const identity = await grokOAuthRequest(this.fetchImpl, discovery.userinfoEndpoint, undefined, undefined, accessToken);
    if (!isRecord(identity)) throw new GrokProtocolError('invalid_identity_response');
    const accountId = requiredString(identity.sub, 512);
    const email = identity.email_verified === true && typeof identity.email === 'string' ? requiredString(identity.email, 254) : undefined;
    return { accessToken, refreshToken, expiresAt, accountId, clientId, issuer: GROK_OAUTH_ISSUER,
      ...(raw.id_token ? { idToken: requiredString(raw.id_token) } : {}), ...(email ? { email } : {}) };
  }
}
''')
put('grokOAuth.ts', '''import { randomUUID } from 'node:crypto';
import { GrokOAuthClient, type GrokDeviceCode, type GrokOAuthTokens } from './grokOAuthClient.js';
import { GrokProtocolError } from './grokProtocol.js';
export type GrokDeviceStatus = 'pending' | 'authorized_pending_publication' | 'applied' | 'expired' | 'denied' | 'error';
interface Session {
  id: string; owner: string; replaceCredentialRef?: string; device?: GrokDeviceCode;
  status: GrokDeviceStatus; expiresAt: number; nextPollAt: number; intervalMs: number;
  userCode: string; verificationUri: string; tokens?: GrokOAuthTokens; error?: string;
  polling?: Promise<ReturnType<GrokDeviceAuthService['status']>>;
}
/** Fixed API-owner sessions; intermediate secrets never leave this service. */
export class GrokDeviceAuthService {
  private readonly sessions = new Map<string, Session>(); private startsInFlight = 0;
  constructor(private readonly client: GrokOAuthClient, private readonly options: { now?: () => number; maxSessions?: number } = {}) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  async start(owner: string, replaceCredentialRef?: string, clientId?: string) {
    this.cleanup();
    if (!owner || this.sessions.size + this.startsInFlight >= (this.options.maxSessions ?? 100)) throw new GrokProtocolError('authorization_capacity', 429);
    this.startsInFlight += 1;
    try {
      const device = await this.client.start(clientId);
      const session: Session = { id: randomUUID(), owner, replaceCredentialRef, device, status: 'pending',
        expiresAt: Math.min(device.expiresAt, this.now() + 30 * 60_000), nextPollAt: this.now() + device.intervalMs,
        intervalMs: device.intervalMs, userCode: device.userCode, verificationUri: device.verificationUri };
      this.sessions.set(session.id, session); return this.status(session.id, owner);
    } finally { this.startsInFlight -= 1; }
  }
  status(id: string, owner: string) {
    const s = this.get(id, owner);
    return { sessionId: s.id, status: s.status, expiresAt: new Date(s.expiresAt).toISOString(),
      intervalMs: s.intervalMs, intervalSeconds: s.intervalMs / 1_000,
      ...(s.status === 'pending' ? { userCode: s.userCode, verificationUri: s.verificationUri } : {}), ...(s.error ? { error: s.error } : {}) };
  }
  async poll(id: string, owner: string) {
    const s = this.get(id, owner); if (s.polling) return s.polling;
    if (s.status !== 'pending' || this.now() < s.nextPollAt) return this.status(id, owner);
    const promise = this.advance(s).finally(() => { s.polling = undefined; }); s.polling = promise; return promise;
  }
  authorizedResult(id: string, owner: string) {
    const s = this.get(id, owner);
    if (s.status !== 'authorized_pending_publication' || !s.tokens) throw new GrokProtocolError('authorization_not_ready', 409);
    return { tokens: s.tokens, replaceCredentialRef: s.replaceCredentialRef };
  }
  complete(id: string, owner: string): void { const s = this.get(id, owner); this.clearSecrets(s); s.status = 'applied'; }
  cancel(id: string, owner: string): void { const s = this.get(id, owner); this.clearSecrets(s); this.sessions.delete(id); }
  private async advance(s: Session) {
    s.nextPollAt = this.now() + s.intervalMs;
    try {
      const tokens = await this.client.poll(s.device!);
      if (this.sessions.get(s.id) !== s || this.now() >= s.expiresAt) { this.clearSecrets(s); s.status = 'expired'; }
      else { s.tokens = tokens; s.device = undefined; s.status = 'authorized_pending_publication'; }
    } catch (error) {
      const code = error instanceof GrokProtocolError ? error.code : 'authorization_error';
      if (code === 'authorization_pending') { /* issuer interval retained */ }
      else if (code === 'slow_down') { s.intervalMs = Math.min(300_000, s.intervalMs + 5_000); s.nextPollAt = this.now() + s.intervalMs; }
      else { s.status = code === 'access_denied' ? 'denied' : code === 'expired_token' ? 'expired' : 'error'; s.error = code; this.clearSecrets(s); }
    }
    if (this.sessions.get(s.id) !== s) throw new GrokProtocolError('authorization_not_found', 404);
    return this.status(s.id, s.owner);
  }
  private get(id: string, owner: string): Session {
    const s = this.sessions.get(id);
    if (!s || !owner || s.owner !== owner) throw new GrokProtocolError('authorization_not_found', 404);
    if (this.now() >= s.expiresAt && s.status !== 'applied') { s.status = 'expired'; this.clearSecrets(s); }
    return s;
  }
  private clearSecrets(s: Session): void { s.tokens = undefined; s.device = undefined; s.userCode = ''; s.verificationUri = ''; }
  private cleanup(): void { for (const [id, s] of this.sessions) if (this.now() >= s.expiresAt) { this.clearSecrets(s); this.sessions.delete(id); } }
}
''')
print('Applied provider-neutral scheduling/state/locks/telemetry and xAI device-code OAuth')
