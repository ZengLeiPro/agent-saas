from pathlib import Path
import re
root=Path('server/src')
def put(path,text):
    p=root/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text.lstrip('\n'))
def edit(path,before,after):
    p=Path(path);s=p.read_text();assert before in s,(path,before);p.write_text(s.replace(before,after,1))
# Preserve the distinction between missing and explicitly malformed quota values.
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
needle='  codex: evaluateCodex,';assert needle in s;s=s.replace(needle,needle+'\n  grok: evaluateGrok,',1);p.write_text(s)
p=Path('web/src/components/PlatformAdmin/configStatusTargets.ts');s=p.read_text()
s=s.replace("  codex: 'Codex',", "  codex: 'Codex',\n  grok: 'Grok',",1)
s=s.replace("  codex: 'codexSubscription.enabled',", "  codex: 'codexSubscription.enabled',\n  grok: 'grokSubscription.enabled',",1)
s=s.replace("  if (path.startsWith('codexSubscription.')) return 'Codex';", "  if (path.startsWith('codexSubscription.')) return 'Codex';\n  if (path.startsWith('grokSubscription.')) return 'Grok';",1);p.write_text(s)
# Select the correct account card when the existing capability navigation parameter is present.
p=Path('web/src/components/ModelManager/index.tsx');s=p.read_text()
needle='  const readOnly = !isPlatformAdmin;';assert needle in s
s=s.replace(needle,needle+'''
  useEffect(() => {
    const capability = new URLSearchParams(window.location.search).get('capability');
    if (capability !== 'grok' && capability !== 'codex') return;
    setActiveSection('general');
    const timer = setTimeout(() => document.getElementById(`${capability}-subscription`)?.scrollIntoView?.({ block: 'start' }), 0);
    return () => clearTimeout(timer);
  }, []);
''',1);p.write_text(s)
# Explicit startup safety: both authentication and subscription inference must be allowlisted.
p=root/'release/environmentSafety.ts';s=p.read_text()
s="import { GROK_DISCOVERY_ENDPOINT, GROK_RESPONSES_ENDPOINT } from '../runtime/responses/grokProtocol.js';\n"+s
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
# Preserve the existing no-key staging preflight logic for both subscription transports.
p=Path('scripts/staging/deploy-staging-release.sh');s=p.read_text()
s=s.replace('transport !== "codex_subscription"', '! ["codex_subscription", "grok_subscription"].includes(transport)')
s=s.replace("transport !== 'codex_subscription'", "! ['codex_subscription', 'grok_subscription'].includes(transport)")
s=s.replace("transport === 'codex_subscription'", "['codex_subscription', 'grok_subscription'].includes(transport)")
s=s.replace('transport === "codex_subscription"', '["codex_subscription", "grok_subscription"].includes(transport)');p.write_text(s)
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
# Only the class constructor owns the provider; the factory signature stays unchanged.
a=s.index('export class PgSubscriptionCredentialRuntimeStateStore');s=s[:a]+s[a:].replace("provider: 'codex' | 'grok' = 'codex',", "private readonly provider: 'codex' | 'grok' = 'codex',",1)
needle='    this.table = `${sanitizeIdentifier(tablePrefix)}_${provider}_credential_runtime_state`;';assert needle in s
s=s.replace(needle,"    this.table = provider === 'grok' ? grokSubscriptionTableName(tablePrefix, 'runtime_state') : `${sanitizeIdentifier(tablePrefix)}_codex_credential_runtime_state`;",1)
a=s.index('      await client.query(`\n        CREATE TABLE IF NOT EXISTS');b=s.index('\n    } finally {',a)
old=s[a:b];s=s[:a]+"      if (this.provider === 'grok') {\n        for (const statement of grokRuntimeStateSchemaStatements(this.table)) await client.query(statement);\n      } else {\n"+old+'\n      }'+s[b:];p.write_text(s)
p=root/'runtime/responses/subscriptionRefreshJournal.ts';s=p.read_text()
s="import { grokSubscriptionTableName } from './grokSubscriptionTableNames.js';\nimport { grokRefreshJournalSchemaStatements } from './grokSubscriptionSchema.js';\n"+s
s=s.replace('this.table = `${prefix.slice(0, 30)}_grok_credential_refresh_journal`;', "this.table = grokSubscriptionTableName(prefix, 'refresh_journal');")
a=s.index('      await client.query(`CREATE TABLE IF NOT EXISTS');b=s.index('\n    } finally {',a)
s=s[:a]+'      for (const statement of grokRefreshJournalSchemaStatements(this.table)) await client.query(statement);'+s[b:];p.write_text(s)
# Register new production startup stores; preserve the original Codex compatibility root.
p=Path('scripts/release/migration-plan.mjs');s=p.read_text();needle="  'server/src/runtime/responses/codexCredentialRuntimeState.ts',";assert needle in s
s=s.replace(needle,needle+"\n  'server/src/runtime/responses/subscriptionCredentialRuntimeState.ts',\n  'server/src/runtime/responses/subscriptionRefreshJournal.ts',",1);p.write_text(s)
put('__tests__/grokSchemaAndCapability.test.ts', '''import { describe, expect, it } from 'vitest';
import { parseAppConfig } from '../app/config.js';
import { capabilityConfigSlice } from '../config/capabilityContract.js';
import { buildCapabilityReadiness } from '../config/capabilityReadiness.js';
import { grokSubscriptionTableName } from '../runtime/responses/grokSubscriptionTableNames.js';
import { grokRuntimeStateSchemaStatements, grokRefreshJournalSchemaStatements } from '../runtime/responses/grokSubscriptionSchema.js';
describe('Grok capability and additive SQL (T18, T24)', () => {
  it('keeps old configurations free of a manufactured Grok object', () => {
    const config = parseAppConfig({}); expect(config.grokSubscription).toBeUndefined();
    expect(capabilityConfigSlice(config, 'grok')).toBeUndefined();
    expect(buildCapabilityReadiness({ config }).grok.missing).toContain('grokSubscription.credentialRefs');
  });
  it('rejects enabled-without-credentials and inline tokens', () => {
    expect(() => parseAppConfig({ grokSubscription: { enabled: true } })).toThrow();
    expect(() => parseAppConfig({ grokSubscription: { enabled: false, accessToken: 'fixture' } })).toThrow();
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
    expect(sql).toHaveLength(3);
    expect(sql.every((statement) => /^CREATE (TABLE|INDEX) IF NOT EXISTS/.test(statement))).toBe(true);
    expect(sql.join(' ')).not.toMatch(/DROP|TRUNCATE|RENAME|codex_/);
  });
});
''')
# Inventory only source locations for the remaining lifecycle/entry audit; no runtime config or secrets.
for p in root.rglob('*.ts'):
    if '__tests__' in str(p) or '.test.' in p.name: continue
    text=p.read_text()
    if any(term in text for term in ['codex_subscription_oauth', 'discardLoginCandidate', 'configOperationId', 'new OpenAI(', 'new ResponsesApiAdapter(']):
        print('GROK_REMAINING_AUDIT',p)
print('Applied Grok capability diagnostics, explicit staging allowlists, provider-isolated additive schema and safety contracts')
