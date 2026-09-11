import { describe, expect, it } from 'vitest';
import { parseAppConfig } from '../app/config.js';
import { capabilityConfigSlice } from '../config/capabilityContract.js';
import { buildCapabilityReadiness } from '../config/capabilityReadiness.js';
import { grokSubscriptionTableName } from '../runtime/responses/grokSubscriptionTableNames.js';
import {
  grokRuntimeStateSchemaStatements,
  grokRefreshJournalSchemaStatements,
} from '../runtime/responses/grokSubscriptionSchema.js';
const base = { agent: { cwd: '/tmp/grok-fixture' }, server: { port: 3200 } };
describe('Grok capability and additive SQL (T18, T24)', () => {
  it('keeps old configurations free of a manufactured Grok object', () => {
    const config = parseAppConfig(base);
    expect(config.grokSubscription).toBeUndefined();
    expect(capabilityConfigSlice(config, 'grok')).toBeUndefined();
    expect(buildCapabilityReadiness({ config }).grok.missing).toContain(
      'grokSubscription.credentialRefs',
    );
  });
  it('rejects enabled-without-credentials and inline tokens', () => {
    expect(() => parseAppConfig({ ...base, grokSubscription: { enabled: true } })).toThrow();
    expect(() =>
      parseAppConfig({ ...base, grokSubscription: { enabled: false, accessToken: 'fixture' } }),
    ).toThrow();
  });
  it('uses independent deterministic SQL names and prevents truncation collisions', () => {
    const prefixes = ['runtime', 'staging_runtime', 'x'.repeat(90) + 'a', 'x'.repeat(90) + 'b'];
    const names = prefixes.flatMap((prefix) =>
      ['runtime_state', 'refresh_journal'].map((kind) =>
        grokSubscriptionTableName(prefix, kind as 'runtime_state' | 'refresh_journal'),
      ),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.length <= 44 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))).toBe(
      true,
    );
    expect(() => grokSubscriptionTableName('runtime;DROP', 'runtime_state')).toThrow();
    expect(grokSubscriptionTableName('runtime', 'runtime_state')).toBe(
      'runtime_grok_credential_runtime_state',
    );
  });
  it('expands two new tables and an index without touching Codex data', () => {
    const sql = [
      ...grokRuntimeStateSchemaStatements(grokSubscriptionTableName('runtime', 'runtime_state')),
      ...grokRefreshJournalSchemaStatements(
        grokSubscriptionTableName('runtime', 'refresh_journal'),
      ),
    ];
    expect(sql).toHaveLength(3);
    expect(sql.every((statement) => /^CREATE (TABLE|INDEX) IF NOT EXISTS/.test(statement))).toBe(
      true,
    );
    expect(sql.join(' ')).not.toMatch(/DROP|TRUNCATE|RENAME|codex_/);
  });
});
