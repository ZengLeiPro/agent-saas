from pathlib import Path
import re
root=Path('server/src')
def put(path,text):
    p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text.lstrip('\n'))
def edit(path,before,after):
    p=Path(path);s=p.read_text();assert before in s,(path,before);p.write_text(s.replace(before,after,1))
p=root/'quota/grokSubscriptionQuota.ts';s=p.read_text();s=s.replace('const explicitValue = config.creditUsagePercent ?? config.credit_usage_percent;', "const explicitValue = Object.hasOwn(config, 'creditUsagePercent') ? config.creditUsagePercent : config.credit_usage_percent;");p.write_text(s)
p=root/'config/capabilityContract.ts';s=p.read_text();s=s.replace("  'codex',","  'codex',\n  'grok',",1)
s=s.replace("  codex: 'platform.resource-center.models',", "  codex: 'platform.resource-center.models',\n  grok: 'platform.resource-center.models',",1)
s=s.replace("    case 'codex':\n      return config.codexSubscription;", "    case 'codex':\n      return config.codexSubscription;\n    case 'grok':\n      return config.grokSubscription;",1);p.write_text(s)
p=root/'config/capabilityRequirements.ts';s=p.read_text();a=s.index('function evaluateWebTools(')
s=s[:a]+'''function evaluateGrok({ config }: CapabilityEvaluationContext): CapabilityDraft {
  const grok = config.grokSubscription;
  const missing = (grok?.credentialRefs?.length ?? (configured(grok?.credentialRef) ? 1 : 0)) > 0 ? [] : ['grokSubscription.credentialRefs'];
  const hasModel = (config.models?.groups ?? []).some((group) => group.models.some((model) =>
    (model.responses_transport ?? group.responses_transport) === 'grok_subscription'));
  const blockers = hasModel ? [] : [dependencyBlocker('缺少 transport 为 grok_subscription 的 Responses 模型；账号授权不会自动修改默认模型', 'models')];
  return draft(grok?.enabled === true, missing, blockers);
}

'''+s[a:]
s=s.replace('  codex: evaluateCodex,','  codex: evaluateCodex,\n  grok: evaluateGrok,',1);p.write_text(s)
p=Path('web/src/components/PlatformAdmin/configStatusTargets.ts');s=p.read_text()
s=s.replace("  codex: 'Codex',", "  codex: 'Codex',\n  grok: 'Grok',",1)
s=s.replace("  codex: 'codexSubscription.enabled',", "  codex: 'codexSubscription.enabled',\n  grok: 'grokSubscription.enabled',",1)
s=s.replace("  if (path.startsWith('codexSubscription.')) return 'Codex';", "  if (path.startsWith('codexSubscription.')) return 'Codex';\n  if (path.startsWith('grokSubscription.')) return 'Grok';",1);p.write_text(s)
p=Path('web/src/components/ModelManager/index.tsx');s=p.read_text();needle='  const updateModels = useCallback';assert needle in s
s=s.replace(needle,'''  useEffect(() => {
    if (loading) return;
    const capability = new URLSearchParams(window.location.search).get('capability');
    if (capability !== 'grok' && capability !== 'codex') return;
    setSelectedPanel({ type: 'general' });
    const timer = setTimeout(() => document.getElementById(`${capability}-subscription`)?.scrollIntoView?.({ block: 'start' }), 0);
    return () => clearTimeout(timer);
  }, [loading]);
'''+needle,1);p.write_text(s)
p=Path('web/src/components/ModelManager/GrokSubscriptionCard.tsx');s=p.read_text();needle='onClick={() => void grok.refresh()}';assert needle in s
s=s.replace(needle,'aria-label="刷新 Grok 订阅状态" '+needle,1);p.write_text(s)
p=root/'release/environmentSafety.ts';s=p.read_text();s="import { GROK_DISCOVERY_ENDPOINT, GROK_RESPONSES_ENDPOINT } from '../runtime/responses/grokProtocol.js';\n"+s
needle="  const oauthEnabled = env.AGENT_SAAS_STAGING_OAUTH_ENABLED;";assert needle in s
s=s.replace(needle,needle+'''
  if (config.grokSubscription?.enabled) {
    if (oauthEnabled !== '1') failures.push('Grok subscription requires explicitly enabled Staging OAuth');
    if (!urlAllowed(config.grokSubscription.endpoint ?? GROK_RESPONSES_ENDPOINT, oauthHosts)
        || !urlAllowed(GROK_DISCOVERY_ENDPOINT, oauthHosts)) {
      failures.push('Grok authentication and subscription endpoints must both be staging-allowlisted');
    }
  }
''',1);p.write_text(s)
edit('scripts/staging/render-config.mjs', "'codexSubscription', 'webTools'", "'codexSubscription', 'grokSubscription', 'webTools'")
p=Path('scripts/release/deploy-staging-release.sh');s=p.read_text()
for q in ["'",'"']:
    s=s.replace(f'transport !== {q}codex_subscription{q}',f'![{q}codex_subscription{q}, {q}grok_subscription{q}].includes(transport)')
    s=s.replace(f'transport === {q}codex_subscription{q}',f'[{q}codex_subscription{q}, {q}grok_subscription{q}].includes(transport)')
p.write_text(s)
put('runtime/responses/grokSubscriptionTableNames.ts', '''import { createHash } from 'node:crypto';
/** Reserve space for constraint/index suffixes; never rely on PostgreSQL's silent truncation. */
export function grokSubscriptionTableName(prefix: string, kind: 'runtime_state' | 'refresh_journal'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(prefix)) throw new Error('Invalid runtime table prefix');
  const suffix = kind === 'runtime_state' ? '_grok_credential_runtime_state' : '_grok_credential_refresh_journal';
  const budget = 44 - suffix.length;
  const safePrefix = prefix.length <= budget ? prefix : `g${createHash('sha256').update(prefix).digest('hex').slice(0, budget - 1)}`;
  return `${safePrefix}${suffix}`;
}
''')
put('runtime/responses/grokSubscriptionSchema.ts', '''// release-migration: expand
/** Additive schema only. No Codex table is renamed, rebuilt, copied, or truncated. */
export function grokRuntimeStateSchemaStatements(table: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (
      credential_ref TEXT PRIMARY KEY,
      availability TEXT NOT NULL,
      credential_generation BIGINT NOT NULL DEFAULT 0,
      cooldown_until TIMESTAMPTZ,
      last_failure_code TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT ${table}_availability_check CHECK (availability IN ('available', 'quota_cooldown', 'auth_unavailable'))
    )`,
    `CREATE INDEX IF NOT EXISTS ${table}_cooldown_idx ON ${table} (cooldown_until)`,
  ];
}
export function grokRefreshJournalSchemaStatements(table: string): string[] {
  return [`CREATE TABLE IF NOT EXISTS ${table} (
    credential_ref TEXT PRIMARY KEY,
    credential_generation BIGINT NOT NULL CHECK (credential_generation > 0),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`];
}
''')
p=root/'runtime/responses/subscriptionCredentialRuntimeState.ts';s=p.read_text()
s="import { grokSubscriptionTableName } from './grokSubscriptionTableNames.js';\nimport { grokRuntimeStateSchemaStatements } from './grokSubscriptionSchema.js';\n"+s
a=s.index('export class PgSubscriptionCredentialRuntimeStateStore');s=s[:a]+s[a:].replace("provider: 'codex' | 'grok' = 'codex',", "private readonly provider: 'codex' | 'grok' = 'codex',",1)
needle='    this.table = `${sanitizeIdentifier(tablePrefix)}_${provider}_credential_runtime_state`;';assert needle in s
s=s.replace(needle,"    this.table = provider === 'grok' ? grokSubscriptionTableName(tablePrefix, 'runtime_state') : `${sanitizeIdentifier(tablePrefix)}_codex_credential_runtime_state`;",1)
a=s.index('      await client.query(`\n        CREATE TABLE IF NOT EXISTS');b=s.index('\n    } finally {',a);old=s[a:b]
s=s[:a]+"      if (this.provider === 'grok') {\n        for (const statement of grokRuntimeStateSchemaStatements(this.table)) await client.query(statement);\n      } else {\n"+old+'\n      }'+s[b:];p.write_text(s)
p=root/'runtime/responses/subscriptionRefreshJournal.ts';s=p.read_text();s="import { grokSubscriptionTableName } from './grokSubscriptionTableNames.js';\nimport { grokRefreshJournalSchemaStatements } from './grokSubscriptionSchema.js';\n"+s
s=s.replace('this.table = `${prefix.slice(0, 30)}_grok_credential_refresh_journal`;', "this.table = grokSubscriptionTableName(prefix, 'refresh_journal');")
a=s.index('      await client.query(`CREATE TABLE IF NOT EXISTS');b=s.index('\n    } finally {',a)
s=s[:a]+'      for (const statement of grokRefreshJournalSchemaStatements(this.table)) await client.query(statement);'+s[b:];p.write_text(s)
p=Path('scripts/release/migration-plan.mjs');s=p.read_text();needle="  'server/src/runtime/responses/codexCredentialRuntimeState.ts',";assert needle in s
s=s.replace(needle,needle+"\n  'server/src/runtime/responses/subscriptionCredentialRuntimeState.ts',\n  'server/src/runtime/responses/subscriptionRefreshJournal.ts',",1);p.write_text(s)
p=root/'runtime/responses/subscriptionCredentialLock.ts';s=p.read_text();needle='export class PgSubscriptionCredentialLock';assert needle in s
s=s.replace(needle,'''export interface PgSubscriptionLockScope {
  <T>(client: PgLockClient, action: () => Promise<T>): Promise<T>;
}

'''+needle,1)
s=s.replace('constructor(private readonly pool: PgLockPool) {}','constructor(private readonly pool: PgLockPool, private readonly scope?: PgSubscriptionLockScope) {}',1)
a=s.index('export class PgSubscriptionCredentialLock');before=s[:a];after=s[a:]
assert 'return await fn();' in after;after=after.replace('return await fn();','return await (this.scope ? this.scope(client, fn) : fn());',1);p.write_text(before+after)
put('runtime/responses/subscriptionPgSessionContext.ts', '''import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import type { PgLockPool, PgSubscriptionLockScope } from './subscriptionCredentialLock.js';
type LockClient = Awaited<ReturnType<PgLockPool['connect']>>;
/** Only queries made in this provider's locked async scope reuse its checked-out client. */
export class SubscriptionPgSessionContext {
  private readonly storage = new AsyncLocalStorage<LockClient>();
  readonly pool: pg.Pool;
  readonly run: PgSubscriptionLockScope = (client, action) => this.storage.run(client, action);
  constructor(pool: pg.Pool) {
    this.pool = new Proxy(pool, {
      get: (target, key) => {
        if (key === 'query') return (...args: unknown[]) => {
          const session = this.storage.getStore() ?? target;
          return Reflect.apply(session.query, session, args);
        };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
}
''')
put('runtime/responses/grokCredentialPersistence.ts', '''import type pg from 'pg';
import { LocalSubscriptionCredentialLock, PgSubscriptionCredentialLock } from './subscriptionCredentialLock.js';
import { createSubscriptionCredentialRuntimeStateStore } from './subscriptionCredentialRuntimeState.js';
import { createGrokRefreshJournal } from './subscriptionRefreshJournal.js';
import { SubscriptionPgSessionContext } from './subscriptionPgSessionContext.js';
/** Pair a lock, state store, and journal so pool-starvation cannot break refresh coordination. */
export async function createGrokCredentialPersistence(pool: pg.Pool | undefined, config?: { backend: string; tablePrefix?: string }) {
  const session = pool ? new SubscriptionPgSessionContext(pool) : undefined;
  const queryPool = session?.pool;
  return {
    lock: pool && session ? new PgSubscriptionCredentialLock(pool, session.run) : new LocalSubscriptionCredentialLock(),
    runtimeStateStore: await createSubscriptionCredentialRuntimeStateStore(queryPool, config, 'grok'),
    refreshJournal: await createGrokRefreshJournal(queryPool, config?.backend === 'pg' ? config.tablePrefix : undefined),
  };
}
''')
p=root/'app/modelSubscriptionRuntime.ts';s=p.read_text();s="import { createGrokCredentialPersistence } from '../runtime/responses/grokCredentialPersistence.js';\n"+s
for name,file in [('PgSubscriptionCredentialLock','subscriptionCredentialLock'),('createSubscriptionCredentialRuntimeStateStore','subscriptionCredentialRuntimeState'),('createGrokRefreshJournal','subscriptionRefreshJournal')]:
    s=s.replace(f"import {{ {name} }} from '../runtime/responses/{file}.js';\n",'')
a=s.index("    ...(pool ? { lock: new PgSubscriptionCredentialLock(pool) } : {}),");b=s.index('    oauthClient,',a)
s=s[:a]+'    ...await createGrokCredentialPersistence(pool, config.runtimeEventStore),\n'+s[b:];p.write_text(s)
put('__tests__/grokTestFixtures.ts', '''import { InMemorySecretVault } from '../security/secretVault.js';
import { GrokCredentialManager, type GrokSubscriptionRuntimeConfig } from '../runtime/responses/grokCredentialManager.js';
import { GrokOAuthClient, type GrokOAuthTokens } from '../runtime/responses/grokOAuthClient.js';
import { GROK_OAUTH_ISSUER } from '../runtime/responses/grokProtocol.js';
import { InMemorySubscriptionCredentialRuntimeStateStore } from '../runtime/responses/subscriptionCredentialRuntimeState.js';
import { InMemorySubscriptionRefreshJournal } from '../runtime/responses/subscriptionRefreshJournal.js';
export function grokTokens(accountId = 'fixture-a', ttlMs = 3_600_000): GrokOAuthTokens {
  return { accessToken: `fixture-access-${accountId}`, refreshToken: `fixture-refresh-${accountId}`, accountId,
    issuer: GROK_OAUTH_ISSUER, clientId: 'fixture-client', email: `${accountId}@example.invalid`, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
}
export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
export async function grokFixture(count = 2) {
  const vault = new InMemorySecretVault();
  const config: GrokSubscriptionRuntimeConfig = { enabled: true, credentialRefs: [], quotaCooldownMinutes: 60 };
  const state = new InMemorySubscriptionCredentialRuntimeStateStore();
  const journal = new InMemorySubscriptionRefreshJournal(); const oauth = new GrokOAuthClient();
  const manager = new GrokCredentialManager({ vault, getConfig: () => config, runtimeStateStore: state, refreshJournal: journal, oauthClient: oauth });
  const refs: string[] = [];
  for (let i = 0; i < count; i += 1) refs.push((await manager.persistLogin(grokTokens(`fixture-${i}`))).credentialRef);
  config.credentialRefs = [...refs]; config.credentialRef = refs[0];
  return { vault, config, state, journal, oauth, manager, refs };
}
''')
put('__tests__/grokCredentialPostgres.test.ts', '''import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { EncryptedFileSecretVault } from '../security/secretVault.js';
import { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { createGrokCredentialPersistence } from '../runtime/responses/grokCredentialPersistence.js';
import { grokSubscriptionTableName } from '../runtime/responses/grokSubscriptionTableNames.js';
import { GrokOAuthClient, type GrokOAuthTokens } from '../runtime/responses/grokOAuthClient.js';
import { grokTokens } from './grokTestFixtures.js';
const connectionString = process.env.TEST_DATABASE_URL;
describe.skipIf(!connectionString)('Grok independent PostgreSQL consumers (T09-T11)', () => {
  it('refreshes once across independent vaults/managers/pools of size one and shares cooldown fencing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'grok-pg-test-'));
    const prefix = `g${randomUUID().replaceAll('-', '').slice(0, 9)}`;
    const poolA = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000, query_timeout: 3000 });
    const poolB = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000, query_timeout: 3000 });
    const vaultA = new EncryptedFileSecretVault(join(directory, 'vault.json'), 'grok-test-encryption-key');
    const vaultB = new EncryptedFileSecretVault(join(directory, 'vault.json'), 'grok-test-encryption-key');
    const config = { enabled: true, credentialRefs: [] as string[], quotaCooldownMinutes: 1 };
    const oauthA = new GrokOAuthClient(); const oauthB = new GrokOAuthClient();
    const refresh = vi.fn(async (old: GrokOAuthTokens) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { ...old, accessToken: 'fixture-access-rotated', refreshToken: 'fixture-refresh-rotated', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    });
    vi.spyOn(oauthA, 'refresh').mockImplementation(refresh); vi.spyOn(oauthB, 'refresh').mockImplementation(refresh);
    try {
      const persistenceA = await createGrokCredentialPersistence(poolA, { backend: 'pg', tablePrefix: prefix });
      const persistenceB = await createGrokCredentialPersistence(poolB, { backend: 'pg', tablePrefix: prefix });
      const managerA = new GrokCredentialManager({ vault: vaultA, getConfig: () => config, oauthClient: oauthA, ...persistenceA });
      const managerB = new GrokCredentialManager({ vault: vaultB, getConfig: () => config, oauthClient: oauthB, ...persistenceB });
      const { credentialRef } = await managerA.persistLogin(grokTokens('shared-account', -1000)); config.credentialRefs = [credentialRef];
      const [a, b] = await Promise.all([managerA.getCredentials(), managerB.getCredentials()]);
      expect(refresh).toHaveBeenCalledTimes(1); expect(a.generation).toBe(2); expect(b.generation).toBe(2);
      expect(a.accessToken).toBe(b.accessToken); expect(await persistenceB.refreshJournal.get(credentialRef)).toBeUndefined();
      await managerA.markQuotaCooldown(credentialRef, 'grok_subscription_quota_exhausted', 2);
      expect(await managerB.getRuntimeState(credentialRef)).toMatchObject({ availability: 'quota_cooldown', credentialGeneration: 2 });
      await managerB.markAuthUnavailable(credentialRef, 'invalid_grant', 2);
      await managerA.markQuotaCooldown(credentialRef, 'quota', 2);
      expect(await managerB.getRuntimeState(credentialRef)).toMatchObject({ availability: 'auth_unavailable' });
      await persistenceB.runtimeStateStore.clear(credentialRef, 3);
      await managerA.markAuthUnavailable(credentialRef, 'late-error', 2);
      expect(await managerB.getRuntimeState(credentialRef)).toBeUndefined();
      config.credentialRefs = []; await managerB.revoke(credentialRef, false);
      await expect(managerA.getCredentialsForCredential(credentialRef)).rejects.toThrow('subscription_disabled_or_removed');
      expect(poolA.waitingCount).toBe(0); expect(poolB.waitingCount).toBe(0);
    } finally {
      // Fresh test-only tables in TEST_DATABASE_URL, never application/production tables.
      for (const kind of ['runtime_state', 'refresh_journal'] as const) await poolA.query(`DROP TABLE IF EXISTS ${grokSubscriptionTableName(prefix, kind)}`).catch(() => undefined);
      await Promise.all([poolA.end(), poolB.end()]); await rm(directory, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  }, 15_000);
});
''')
put('__tests__/grokCredentialLifecycle.test.ts', '''import { afterEach, describe, expect, it, vi } from 'vitest';
import { GrokCredentialManager } from '../runtime/responses/grokCredentialManager.js';
import { GrokProtocolError } from '../runtime/responses/grokProtocol.js';
import { grokFixture, grokTokens } from './grokTestFixtures.js';
afterEach(() => vi.restoreAllMocks());
describe('Grok credential lifecycle (T08, T10-T12, T23, T36)', () => {
  it('coalesces same-process refresh, masks metadata, and never refreshes a status GET', async () => {
    const f = await grokFixture(1);
    const refresh = vi.spyOn(f.oauth, 'refresh').mockImplementation(async (old) => ({ ...old, accessToken: 'fixture-new', refreshToken: 'fixture-rotated' }));
    await f.manager.getStatuses(); expect(refresh).not.toHaveBeenCalled();
    const tokens = await Promise.all(Array.from({ length: 12 }, () => f.manager.getCredentials(true, 1)));
    expect(refresh).toHaveBeenCalledTimes(1); expect(new Set(tokens.map((token) => token.generation))).toEqual(new Set([2]));
    const publicState = JSON.stringify(await f.manager.getStatuses());
    expect(publicState).not.toMatch(/fixture-new|fixture-rotated|fixture-access|fixture-refresh/);
    expect(publicState).toContain('***@example.invalid');
  });
  it('preserves current-generation auth over quota and rejects delayed old-generation failures', async () => {
    const f = await grokFixture(1); const ref = f.refs[0];
    await f.manager.markAuthUnavailable(ref, 'invalid_grant', 1); await f.manager.markQuotaCooldown(ref, 'quota', 1);
    expect(await f.manager.getRuntimeState(ref)).toMatchObject({ availability: 'auth_unavailable' });
    await f.state.clear(ref, 2); await f.manager.markAuthUnavailable(ref, 'late', 1);
    expect(await f.manager.getRuntimeState(ref)).toBeUndefined();
  });
  it('does not replay a rotating refresh token after an unknown upstream outcome', async () => {
    const f = await grokFixture(1);
    const refresh = vi.spyOn(f.oauth, 'refresh').mockRejectedValue(new GrokProtocolError('network_outcome_unknown', undefined, true));
    await expect(f.manager.getCredentials(true, 1)).rejects.toThrow('refresh_outcome_unknown');
    await expect(f.manager.getCredentials(true, 1)).rejects.toThrow('refresh_outcome_unknown');
    expect(refresh).toHaveBeenCalledTimes(1); expect(await f.journal.get(f.refs[0])).toBe(1);
  });
  it('recovers a rotated Vault version after a lost acknowledgement without exchanging the old token again', async () => {
    const f = await grokFixture(1); const rotate = f.vault.rotateSecret.bind(f.vault);
    vi.spyOn(f.vault, 'rotateSecret').mockImplementationOnce(async (...args) => { await rotate(...args); throw new Error('fixture lost acknowledgement'); });
    const refresh = vi.spyOn(f.oauth, 'refresh').mockImplementation(async (old) => ({ ...old, accessToken: 'fixture-rotated-once' }));
    await expect(f.manager.getCredentials(true, 1)).rejects.toThrow('refresh_outcome_unknown');
    expect(await f.manager.getPendingPublicationRefs()).toEqual([f.refs[0]]);
    const recovered = await f.manager.getCredentials();
    expect(recovered.generation).toBe(2); expect(recovered.accessToken).toBe('fixture-rotated-once');
    expect(refresh).toHaveBeenCalledTimes(1); expect(await f.journal.get(f.refs[0])).toBeUndefined();
  });
  it('cannot resurrect a ref detached while the OAuth exchange was in flight', async () => {
    const f = await grokFixture(1); let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(f.oauth, 'refresh').mockImplementation(async (old) => { entered(); await gate; return { ...old, accessToken: 'fixture-late' }; });
    const pending = f.manager.getCredentials(true, 1); const rejected = expect(pending).rejects.toThrow('subscription_disabled_or_removed');
    await started; f.config.credentialRefs = []; delete f.config.credentialRef;
    const revoke = f.manager.revoke(f.refs[0], false); release(); await rejected; await revoke;
    expect(f.manager.getCredentialRefs()).toEqual([]);
    await expect(f.manager.getCredentialsForCredential(f.refs[0])).rejects.toThrow('subscription_disabled_or_removed');
  });
  it('rejects duplicate identities and prevents compensation from revoking configured grants', async () => {
    const f = await grokFixture(1); const remote = vi.spyOn(f.oauth, 'revoke').mockResolvedValue(true);
    await expect(f.manager.assertUniqueAccount(grokTokens('fixture-0'), f.refs)).rejects.toThrow('account_already_registered');
    await expect(f.manager.assertUniqueAccount(grokTokens('wrong-account'), f.refs, f.refs[0])).rejects.toThrow('reauthorization_account_mismatch');
    await expect(f.manager.discardLoginCandidate(f.refs[0])).rejects.toThrow('credential_already_published');
    const candidate = await f.manager.persistLogin(grokTokens('fixture-0'));
    await f.manager.discardLoginCandidate(candidate.credentialRef); expect(remote).not.toHaveBeenCalled();
    expect((await f.manager.getStatus(f.refs[0])).connected).toBe(true);
  });
  it('requires a production publication transaction before consuming a refresh token', async () => {
    const f = await grokFixture(1); const refresh = vi.spyOn(f.oauth, 'refresh');
    const manager = new GrokCredentialManager({ vault: f.vault, getConfig: () => f.config, oauthClient: f.oauth,
      runtimeStateStore: f.state, refreshJournal: f.journal, requireRotationCoordinator: true });
    await expect(manager.getCredentials(true, 1)).rejects.toThrow('credential_publication_unavailable');
    expect(refresh).not.toHaveBeenCalled(); expect(await f.journal.get(f.refs[0])).toBeUndefined();
  });
  it('does not grant broad-scope users access to platform subscription secrets', async () => {
    const f = await grokFixture(1);
    await expect(f.vault.getSecret(f.refs[0], { actor: 'user', userId: 'admin', scopes: ['secret:*:read'] })).rejects.toThrow('system-only');
  });
});
''')
put('__tests__/grokSchemaAndCapability.test.ts', '''import { describe, expect, it } from 'vitest';
import { parseAppConfig } from '../app/config.js';
import { capabilityConfigSlice } from '../config/capabilityContract.js';
import { buildCapabilityReadiness } from '../config/capabilityReadiness.js';
import { grokSubscriptionTableName } from '../runtime/responses/grokSubscriptionTableNames.js';
import { grokRuntimeStateSchemaStatements, grokRefreshJournalSchemaStatements } from '../runtime/responses/grokSubscriptionSchema.js';
const base = { agent: { cwd: '/tmp/grok-fixture' } };
describe('Grok capability and additive SQL (T18, T24)', () => {
  it('keeps old configurations free of a manufactured Grok object', () => {
    const config = parseAppConfig(base); expect(config.grokSubscription).toBeUndefined();
    expect(capabilityConfigSlice(config, 'grok')).toBeUndefined();
    expect(buildCapabilityReadiness({ config }).grok.missing).toContain('grokSubscription.credentialRefs');
  });
  it('rejects enabled-without-credentials and inline tokens', () => {
    expect(() => parseAppConfig({ ...base, grokSubscription: { enabled: true } })).toThrow();
    expect(() => parseAppConfig({ ...base, grokSubscription: { enabled: false, accessToken: 'fixture' } })).toThrow();
  });
  it('uses independent deterministic SQL names and prevents truncation collisions', () => {
    const prefixes = ['runtime', 'staging_runtime', 'x'.repeat(90) + 'a', 'x'.repeat(90) + 'b'];
    const names = prefixes.flatMap((prefix) => ['runtime_state', 'refresh_journal'].map((kind) => grokSubscriptionTableName(prefix, kind as 'runtime_state' | 'refresh_journal')));
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length <= 44 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))).toBe(true);
    expect(() => grokSubscriptionTableName('runtime;DROP', 'runtime_state')).toThrow();
    expect(grokSubscriptionTableName('runtime', 'runtime_state')).toBe('runtime_grok_credential_runtime_state');
  });
  it('expands two new tables and an index without touching Codex data', () => {
    const sql = [...grokRuntimeStateSchemaStatements(grokSubscriptionTableName('runtime', 'runtime_state')),
      ...grokRefreshJournalSchemaStatements(grokSubscriptionTableName('runtime', 'refresh_journal'))];
    expect(sql).toHaveLength(3); expect(sql.every((statement) => /^CREATE (TABLE|INDEX) IF NOT EXISTS/.test(statement))).toBe(true);
    expect(sql.join(' ')).not.toMatch(/DROP|TRUNCATE|RENAME|codex_/);
  });
});
''')
print('Applied capability/environment/schema integration; same-connection PG lock scope; independent PG and credential lifecycle regressions')
