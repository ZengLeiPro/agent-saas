from pathlib import Path
import re
root = Path('server/src')
def put(path, text):
    p = root / path; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(text.lstrip('\n'))
def replace(path, before, after):
    p = root / path; s = p.read_text(); assert before in s, (path, before); p.write_text(s.replace(before, after, 1))
put('runtime/egressRequestPolicy.ts', '''/** Local-only request policy: not serialized as a header or sent to the provider. */
const SINGLE_ATTEMPT = Symbol.for('agent-saas.egress.single-attempt');
type EgressRequestInit = RequestInit & { [SINGLE_ATTEMPT]?: true };
export function isSingleAttemptEgressRequest(init?: RequestInit): boolean {
  return (init as EgressRequestInit | undefined)?.[SINGLE_ATTEMPT] === true;
}
/** Rotating OAuth grants and uncertain model requests must never be replayed by proxy fallback. */
export function singleAttemptEgressFetch(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, [SINGLE_ATTEMPT]: true } as EgressRequestInit);
}
''')
p = root / 'runtime/egressDispatcher.ts'; s = p.read_text()
s = "import { isSingleAttemptEgressRequest } from './egressRequestPolicy.js';\n" + s
before = 'if (!failOpen || !isProxyTransportError(err)) throw err;'; assert before in s
s = s.replace(before, 'if (!failOpen || isSingleAttemptEgressRequest(init) || !isProxyTransportError(err)) throw err;', 1); p.write_text(s)
p = root / 'runtime/responses/grokProtocol.ts'; s = p.read_text()
s = "import { singleAttemptEgressFetch } from '../egressRequestPolicy.js';\n" + s
assert 'await fetchImpl(url, {' in s
s = s.replace('await fetchImpl(url, {', 'await singleAttemptEgressFetch(fetchImpl)(url, {', 1); p.write_text(s)
p = root / 'runtime/responses/grokOAuthClient.ts'; s = p.read_text()
s = "import { singleAttemptEgressFetch } from '../egressRequestPolicy.js';\n" + s
assert 'await this.fetchImpl(revocationEndpoint, {' in s
s = s.replace('await this.fetchImpl(revocationEndpoint, {', 'await singleAttemptEgressFetch(this.fetchImpl)(revocationEndpoint, {', 1)
s = s.replace('return response.ok;', "return response.ok && !/text\\/html/i.test(response.headers.get('content-type') ?? '');")
p.write_text(s)
p = root / 'security/secretVault.ts'; s = p.read_text()
needle = "  codex_subscription_oauth: {"; assert needle in s
s = s.replace(needle, "  grok_subscription_oauth: { read: ['__system__'], write: ['__system__'], rotate: ['__system__'], revoke: ['__system__'] },\n" + needle, 1)
needle = '  const requiredScope = `secret:${secret.kind}:${operation}`;'; assert needle in s
s = s.replace(needle, "  if (secret.kind === 'grok_subscription_oauth' && caller.actor !== 'system') {\n    throw new Error('vault access denied: Grok subscription credentials are system-only');\n  }\n" + needle, 1)
p.write_text(s)
put('runtime/responses/grokCredentialTypes.ts', '''import type { GrokOAuthTokens } from './grokOAuthClient.js';
export const GROK_SECRET_KIND = 'grok_subscription_oauth';
export interface GrokSubscriptionRuntimeConfig {
  enabled?: boolean; credentialRef?: string; credentialRefs?: string[];
  quotaCooldownMinutes?: number; endpoint?: string; oauthClientId?: string;
}
export interface GrokTokenBundle extends GrokOAuthTokens { generation: number; credentialRef?: string }
export class GrokCredentialError extends Error {
  constructor(readonly code: string, readonly credentialGeneration = 0) {
    super(`Grok ${code}`); this.name = 'GrokCredentialError';
  }
}
export interface GrokCredentialStatus {
  id?: string; priority?: number; configured: boolean; connected: boolean;
  accountBindingHash?: string; accountIdHint?: string; email?: string;
  expiresAt?: string; accessTokenExpired?: boolean; generation?: number;
  availability?: 'available' | 'quota_cooldown' | 'auth_unavailable';
  cooldownUntil?: string; lastFailureCode?: string; error?: string;
}
''')
put('runtime/responses/grokCredentialRepository.ts', '''import type { SecretVault, VaultCaller, VaultOperation } from '../../security/secretVault.js';
import { hashAccountBinding } from './subscriptionAccountBinding.js';
import { GROK_OAUTH_ISSUER, GrokProtocolError, isRecord, requiredString } from './grokProtocol.js';
import { GROK_SECRET_KIND, GrokCredentialError, type GrokTokenBundle } from './grokCredentialTypes.js';
import type { GrokOAuthTokens } from './grokOAuthClient.js';
function caller(operation: VaultOperation): VaultCaller {
  return { actor: 'system', userId: '__system__', scopes: [`secret:${GROK_SECRET_KIND}:${operation}`] };
}
/** Tokens never cross this server-side boundary; kind/owner are checked independently of ref possession. */
export class GrokCredentialRepository {
  constructor(private readonly vault: SecretVault) {}
  async read(ref: string, generation = 0): Promise<GrokTokenBundle> {
    try {
      this.vault.invalidate?.(ref);
      if (!this.vault.inspectRef) throw new GrokProtocolError('vault_metadata_unavailable');
      const metadata = await this.vault.inspectRef(ref, caller('read'));
      if (!metadata || metadata.revokedAt) throw new GrokCredentialError('credential_unavailable', generation);
      if (metadata.kind !== GROK_SECRET_KIND || metadata.ownerId !== 'global') throw new GrokCredentialError('credential_scope_mismatch', generation);
      return parseBundle(await this.vault.getSecret(ref, caller('read')));
    } catch (error) {
      if (error instanceof GrokCredentialError || error instanceof GrokProtocolError) throw error;
      const message = error instanceof Error ? error.message : '';
      if (/secret not found|secret revoked|access denied/i.test(message)) throw new GrokCredentialError('credential_unavailable', generation);
      throw new GrokProtocolError('vault_read_failed');
    }
  }
  async create(tokens: GrokOAuthTokens, metadata: Record<string, unknown> = {}) {
    const bundle: GrokTokenBundle = { ...tokens, generation: 1 };
    parseBundle(JSON.stringify(bundle));
    const ref = await this.vault.putSecret('global', GROK_SECRET_KIND, JSON.stringify(bundle), caller('write'), {
      ...metadata, accountBindingHash: hashAccountBinding(tokens.accountId),
    });
    return { credentialRef: ref.id, bundle };
  }
  async rotate(ref: string, bundle: GrokTokenBundle): Promise<void> {
    const { credentialRef: _runtimeRef, ...stored } = bundle;
    await this.vault.rotateSecret(ref, JSON.stringify(stored), caller('rotate'));
    this.vault.invalidate?.(ref);
  }
  async revoke(ref: string): Promise<void> {
    await this.vault.revokeSecret(ref, caller('revoke')); this.vault.invalidate?.(ref);
  }
}
function parseBundle(raw: string): GrokTokenBundle {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.issuer !== GROK_OAUTH_ISSUER || !Number.isSafeInteger(value.generation) || Number(value.generation) < 1) throw new Error();
    const expiresAt = requiredString(value.expiresAt, 64);
    if (!Number.isFinite(Date.parse(expiresAt))) throw new Error();
    return {
      accessToken: requiredString(value.accessToken), refreshToken: requiredString(value.refreshToken),
      accountId: requiredString(value.accountId, 512), clientId: requiredString(value.clientId, 256),
      issuer: GROK_OAUTH_ISSUER, expiresAt, generation: Number(value.generation),
      ...(value.idToken ? { idToken: requiredString(value.idToken) } : {}),
      ...(value.email ? { email: requiredString(value.email, 254) } : {}),
    };
  } catch { throw new GrokCredentialError('credential_invalid'); }
}
''')
put('runtime/responses/subscriptionRefreshJournal.ts', '''import pg from 'pg';
const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;
/** A generation-only fence; no token, hash of a token, or account identity is persisted here. */
export interface SubscriptionRefreshJournal {
  get(ref: string): Promise<number | undefined>;
  begin(ref: string, generation: number): Promise<void>;
  clear(ref: string, generation?: number): Promise<void>;
}
export class InMemorySubscriptionRefreshJournal implements SubscriptionRefreshJournal {
  private readonly pending = new Map<string, number>();
  async get(ref: string) { return this.pending.get(ref); }
  async begin(ref: string, generation: number) {
    if (this.pending.has(ref)) throw new Error('subscription refresh is already pending');
    this.pending.set(ref, generation);
  }
  async clear(ref: string, generation?: number) {
    if (generation === undefined || this.pending.get(ref) === generation) this.pending.delete(ref);
  }
}
export class PgGrokRefreshJournal implements SubscriptionRefreshJournal {
  readonly table: string;
  constructor(private readonly pool: PgPool, prefix = 'runtime') {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,29}$/.test(prefix)) throw new Error('Invalid runtime table prefix');
    this.table = `${prefix}_grok_credential_refresh_journal`;
  }
  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [`${this.table}:init`]);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
        credential_ref TEXT PRIMARY KEY, credential_generation BIGINT NOT NULL CHECK (credential_generation > 0),
        started_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`${this.table}:init`]).catch(() => undefined);
      client.release();
    }
  }
  async get(ref: string): Promise<number | undefined> {
    const result = await this.pool.query(`SELECT credential_generation FROM ${this.table} WHERE credential_ref = $1`, [ref]);
    if (!result.rows[0]) return undefined;
    const generation = Number(result.rows[0].credential_generation);
    if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid refresh generation');
    return generation;
  }
  async begin(ref: string, generation: number): Promise<void> {
    await this.pool.query(`INSERT INTO ${this.table} (credential_ref, credential_generation) VALUES ($1, $2)`, [ref, generation]);
  }
  async clear(ref: string, generation?: number): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.table} WHERE credential_ref = $1${generation === undefined ? '' : ' AND credential_generation = $2'}`,
      generation === undefined ? [ref] : [ref, generation]);
  }
}
export async function createGrokRefreshJournal(pool: PgPool | undefined, prefix?: string): Promise<SubscriptionRefreshJournal> {
  if (!pool) return new InMemorySubscriptionRefreshJournal();
  const journal = new PgGrokRefreshJournal(pool, prefix); await journal.init(); return journal;
}
''')
put('runtime/responses/grokCredentialManager.ts', '''import type { SecretVault } from '../../security/secretVault.js';
import { hashAccountBinding, orderedCredentialRefs } from './subscriptionAccountBinding.js';
import { LocalSubscriptionCredentialLock, type SubscriptionCredentialLock } from './subscriptionCredentialLock.js';
import { InMemorySubscriptionCredentialRuntimeStateStore, type SubscriptionCredentialRuntimeStateStore } from './subscriptionCredentialRuntimeState.js';
import { InMemorySubscriptionRefreshJournal, type SubscriptionRefreshJournal } from './subscriptionRefreshJournal.js';
import { SubscriptionTelemetry, type SubscriptionWireRequestSample } from './subscriptionTelemetry.js';
import { GrokOAuthClient, type GrokOAuthTokens } from './grokOAuthClient.js';
import { GROK_OAUTH_CLIENT_ID, GROK_RESPONSES_ENDPOINT, GrokProtocolError, validateGrokEndpoint } from './grokProtocol.js';
import { GrokCredentialRepository } from './grokCredentialRepository.js';
import { GrokCredentialError, type GrokCredentialStatus, type GrokSubscriptionRuntimeConfig, type GrokTokenBundle } from './grokCredentialTypes.js';
export { GrokCredentialError, type GrokCredentialStatus, type GrokSubscriptionRuntimeConfig, type GrokTokenBundle } from './grokCredentialTypes.js';
export class GrokCredentialManager {
  private readonly repository: GrokCredentialRepository;
  private readonly lock: SubscriptionCredentialLock;
  private readonly state: SubscriptionCredentialRuntimeStateStore;
  private readonly journal: SubscriptionRefreshJournal;
  private readonly oauth: GrokOAuthClient;
  private readonly telemetry = new SubscriptionTelemetry();
  private readonly inFlight = new Map<string, Promise<GrokTokenBundle>>();
  private coordinator?: (ref: string) => Promise<void>;
  constructor(private readonly options: {
    vault: SecretVault; getConfig: () => GrokSubscriptionRuntimeConfig | undefined;
    lock?: SubscriptionCredentialLock; runtimeStateStore?: SubscriptionCredentialRuntimeStateStore;
    refreshJournal?: SubscriptionRefreshJournal; oauthClient?: GrokOAuthClient; fetchImpl?: typeof fetch;
    credentialRotationCoordinator?: (ref: string) => Promise<void>; now?: () => number;
  }) {
    this.repository = new GrokCredentialRepository(options.vault);
    this.lock = options.lock ?? new LocalSubscriptionCredentialLock();
    this.state = options.runtimeStateStore ?? new InMemorySubscriptionCredentialRuntimeStateStore();
    this.journal = options.refreshJournal ?? new InMemorySubscriptionRefreshJournal();
    this.oauth = options.oauthClient ?? new GrokOAuthClient(options.fetchImpl, options.now);
    this.coordinator = options.credentialRotationCoordinator;
  }
  setCredentialRotationCoordinator(coordinator: ((ref: string) => Promise<void>) | undefined): void { this.coordinator = coordinator; }
  getCredentialRefs(): string[] { return orderedCredentialRefs(this.options.getConfig()); }
  getConfiguration() {
    const config = this.options.getConfig() ?? {}; const credentialRefs = this.getCredentialRefs();
    return { enabled: config.enabled === true, credentialRefs, credentialRef: credentialRefs[0],
      endpoint: validateGrokEndpoint(config.endpoint ?? GROK_RESPONSES_ENDPOINT),
      quotaCooldownMinutes: config.quotaCooldownMinutes ?? 60, oauthClientId: config.oauthClientId ?? GROK_OAUTH_CLIENT_ID };
  }
  isConfigured(ref: string): boolean { return this.getConfiguration().enabled && this.getCredentialRefs().includes(ref); }
  async getCredentials(force = false, staleGeneration?: number, ref?: string): Promise<GrokTokenBundle> {
    return this.getCredentialsForCredential(ref ?? this.getCredentialRefs()[0], force, staleGeneration);
  }
  async getCredentialsForCredential(ref: string | undefined, force = false, staleGeneration?: number): Promise<GrokTokenBundle> {
    if (!ref) throw new GrokProtocolError('subscription_not_configured', 503);
    this.assertConfigured(ref);
    const observed = await this.readBundle(ref); const pending = await this.journal.get(ref);
    const unavailable = await this.state.get(ref);
    if (pending === undefined && unavailable?.availability === 'auth_unavailable') throw new GrokCredentialError(unavailable.lastFailureCode ?? 'auth_unavailable', observed.generation);
    if (pending === undefined && !this.expiring(observed) && (!force || (staleGeneration !== undefined && observed.generation > staleGeneration))) return { ...observed, credentialRef: ref };
    const active = this.inFlight.get(ref); if (active) return active;
    const promise = this.refresh(ref, observed.generation, force, staleGeneration).finally(() => {
      if (this.inFlight.get(ref) === promise) this.inFlight.delete(ref);
    });
    this.inFlight.set(ref, promise); return promise;
  }
  async persistLogin(tokens: GrokOAuthTokens, existingRef?: string, metadata: Record<string, unknown> = {}) {
    if (existingRef) throw new GrokProtocolError('reauthorization_requires_candidate');
    const candidate = await this.repository.create(tokens, metadata);
    try { await this.state.clear(candidate.credentialRef, candidate.bundle.generation); }
    catch { await this.repository.revoke(candidate.credentialRef).catch(() => undefined); throw new GrokProtocolError('candidate_state_failed'); }
    return candidate;
  }
  async assertUniqueAccount(tokens: GrokOAuthTokens, refs: readonly string[], replaceRef?: string): Promise<void> {
    for (const ref of refs) {
      let previous: GrokTokenBundle;
      try { previous = await this.repository.read(ref); }
      catch (error) { if (error instanceof GrokCredentialError) continue; throw error; }
      if (ref === replaceRef) {
        if (previous.accountId !== tokens.accountId) throw new GrokProtocolError('reauthorization_account_mismatch', 409);
      } else if (previous.accountId === tokens.accountId) throw new GrokProtocolError('account_already_registered', 409);
    }
  }
  async discardLoginCandidate(ref: string): Promise<void> {
    if (this.getCredentialRefs().includes(ref)) throw new GrokProtocolError('credential_already_published', 409);
    await this.lock.runExclusive(this.lockKey(ref), async () => {
      if (this.getCredentialRefs().includes(ref)) throw new GrokProtocolError('credential_already_published', 409);
      await this.repository.revoke(ref); await this.state.clear(ref); await this.journal.clear(ref);
    });
  }
  async revoke(ref: string, remote = true): Promise<{ remoteWarning?: string }> {
    const bundle = await this.lock.runExclusive(this.lockKey(ref), async () => {
      if (this.getCredentialRefs().includes(ref)) throw new GrokProtocolError('credential_still_configured', 409);
      let stored: GrokTokenBundle | undefined;
      try { stored = await this.repository.read(ref); } catch (error) { if (!(error instanceof GrokCredentialError)) throw error; }
      await this.repository.revoke(ref); await this.state.clear(ref); await this.journal.clear(ref); return stored;
    });
    // Reauthorization/candidate cleanup must not revoke a grant shared by the new credentials.
    if (!remote) return {};
    const confirmed = bundle ? await this.oauth.revoke(bundle).catch(() => false) : false;
    return confirmed ? {} : { remoteWarning: '本地凭据已停用；xAI 远端撤销未确认。' };
  }
  async getRuntimeState(ref: string) {
    const current = await this.state.get(ref);
    if (current) {
      // A Vault write can succeed while its acknowledgement is lost. A later generation may recover
      // the publication fence without resending the already-consumed refresh token.
      try {
        const bundle = await this.repository.read(ref, current.credentialGeneration);
        if (bundle.generation > current.credentialGeneration) await this.state.clear(ref, bundle.generation);
      } catch (error) { if (!(error instanceof GrokCredentialError)) throw error; }
    }
    return this.state.get(ref);
  }
  getRuntimeGeneration(ref: string) { return this.state.getGeneration(ref); }
  async markQuotaCooldown(ref: string, code: string, generation = 0): Promise<string> {
    const until = new Date(this.now() + this.getConfiguration().quotaCooldownMinutes * 60_000).toISOString();
    if (this.getCredentialRefs().includes(ref)) await this.state.markQuotaCooldown(ref, until, code, generation);
    return until;
  }
  async markAuthUnavailable(ref: string, code: string, generation = 0): Promise<void> {
    if (this.getCredentialRefs().includes(ref)) await this.state.markAuthUnavailable(ref, code, generation);
  }
  async getStatuses(): Promise<GrokCredentialStatus[]> {
    return Promise.all(this.getCredentialRefs().map(async (ref, index) => ({ ...await this.getStatus(ref), priority: index + 1 })));
  }
  async getStatus(ref = this.getCredentialRefs()[0]): Promise<GrokCredentialStatus> {
    if (!ref) return { configured: false, connected: false };
    try {
      const bundle = await this.readBundle(ref); const state = await this.state.get(ref);
      return { id: ref, configured: true, connected: state?.availability !== 'auth_unavailable',
        accountBindingHash: hashAccountBinding(bundle.accountId), accountIdHint: bundle.accountId.slice(-6),
        ...(bundle.email ? { email: maskEmail(bundle.email) } : {}), expiresAt: bundle.expiresAt,
        accessTokenExpired: Date.parse(bundle.expiresAt) <= this.now(), generation: bundle.generation,
        availability: state?.availability ?? 'available', cooldownUntil: state?.cooldownUntil, lastFailureCode: state?.lastFailureCode };
    } catch (error) { return { id: ref, configured: true, connected: false, error: safeError(error) }; }
  }
  getRuntimeStatus() { return this.telemetry.snapshot(); }
  recordModelResult(input: Parameters<SubscriptionTelemetry['recordResult']>[0]): void {
    this.telemetry.recordResult({ ...input, cacheEligible: false, errorCode: input.errorCode ? 'provider_error' : undefined });
  }
  recordModelFailure(model: string, error: unknown): void { this.telemetry.recordFailure(model, safeError(error)); }
  recordWireRequest(input: SubscriptionWireRequestSample): void { this.telemetry.recordWireRequest({ ...input, fallbackReason: undefined }); }
  private async refresh(ref: string, observedGeneration: number, force: boolean, staleGeneration?: number): Promise<GrokTokenBundle> {
    const result = await this.lock.runExclusive(this.lockKey(ref), async () => {
      this.assertConfigured(ref); const latest = await this.readBundle(ref); const pending = await this.journal.get(ref);
      if (pending !== undefined) {
        if (latest.generation > pending) { await this.state.clear(ref, latest.generation); return { bundle: latest, pending }; }
        await this.state.markAuthUnavailable(ref, 'refresh_outcome_unknown', latest.generation);
        throw new GrokCredentialError('refresh_outcome_unknown', latest.generation);
      }
      if (!this.expiring(latest) && (!force || latest.generation > (staleGeneration ?? observedGeneration))) return { bundle: latest };
      const state = await this.state.get(ref);
      if (state?.availability === 'auth_unavailable') throw new GrokCredentialError(state.lastFailureCode ?? 'auth_unavailable', latest.generation);
      await this.journal.begin(ref, latest.generation);
      try {
        const tokens = await this.oauth.refresh(latest); this.assertConfigured(ref);
        const next: GrokTokenBundle = { ...tokens, generation: latest.generation + 1 };
        await this.repository.rotate(ref, next); await this.state.clear(ref, next.generation);
        this.telemetry.recordRefreshSuccess(next.generation); return { bundle: next, pending: latest.generation };
      } catch (error) {
        this.telemetry.recordRefreshFailure(safeError(error));
        if (error instanceof GrokProtocolError && !error.outcomeUnknown) {
          await this.journal.clear(ref, latest.generation);
          if (error.code === 'invalid_grant' || error.code === 'invalid_token') {
            await this.state.markAuthUnavailable(ref, error.code, latest.generation);
            throw new GrokCredentialError(error.code, latest.generation);
          }
          throw error;
        }
        await this.state.markAuthUnavailable(ref, 'refresh_outcome_unknown', latest.generation);
        throw new GrokProtocolError('refresh_outcome_unknown', undefined, true);
      }
    });
    // Global publication locks are acquired only AFTER releasing the credential lock.
    // The durable generation fence survives failure/restart and prevents refresh replay.
    if (result.pending !== undefined) {
      try { if (this.getCredentialRefs().includes(ref)) await this.coordinator?.(ref); }
      catch { throw new GrokProtocolError('credential_publication_pending'); }
      await this.journal.clear(ref, result.pending);
    }
    this.assertConfigured(ref); return { ...result.bundle, credentialRef: ref };
  }
  private async readBundle(ref: string): Promise<GrokTokenBundle> {
    const generation = await this.state.getGeneration(ref); const bundle = await this.repository.read(ref, generation);
    if (generation === undefined || bundle.generation > generation) await this.state.clear(ref, bundle.generation);
    return bundle;
  }
  private assertConfigured(ref: string): void { if (!this.isConfigured(ref)) throw new GrokProtocolError('subscription_disabled_or_removed', 503); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private expiring(bundle: GrokTokenBundle): boolean { return Date.parse(bundle.expiresAt) <= this.now() + 300_000; }
  private lockKey(ref: string): string { return `agent-saas:grok-oauth:${ref}`; }
}
function safeError(error: unknown): string {
  return error instanceof GrokProtocolError || error instanceof GrokCredentialError ? error.code : 'provider_request_failed';
}
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@'); return at > 0 ? `${email.slice(0, 1)}***${email.slice(at)}` : '***';
}
''')
print('Applied Grok Vault lifecycle, durable refresh fencing, provider-isolated locks, and non-replaying egress')
