import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { PgCodexCredentialRuntimeStateStore } from '../runtime/responses/codexCredentialRuntimeState.js';
import { PgSubscriptionCredentialRuntimeStateStore } from '../runtime/responses/subscriptionCredentialRuntimeState.js';
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/grok-codex-schema-baseline.json', import.meta.url), 'utf8'),
) as { statements: string[] };
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
describe('Codex schema preservation through common Grok infrastructure', () => {
  it.each([PgCodexCredentialRuntimeStateStore, PgSubscriptionCredentialRuntimeStateStore])(
    'preserves original DDL and names through %s',
    async (Store) => {
      const queries: string[] = [];
      const query = vi.fn(async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      });
      const pool = {
        connect: async () => ({ query, release: vi.fn() }),
        query,
      } as unknown as ConstructorParameters<typeof Store>[0];
      const store = new Store(pool, 'schema_fixture');
      await store.init();
      expect(queries.filter((q) => /^\s*CREATE/.test(q)).map(normalize)).toEqual(
        fixture.statements.map((q) =>
          normalize(q.replaceAll('${this.table}', 'schema_fixture_codex_credential_runtime_state')),
        ),
      );
    },
  );
});
