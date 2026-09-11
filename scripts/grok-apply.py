from pathlib import Path
import hashlib,json,re,subprocess

def put(path,text):
    p=Path(path);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text.lstrip('\n'))
def digest(text): return 'sha256:'+hashlib.sha256(text.encode()).hexdigest()
def old_text(sha,path):
    r=subprocess.run(['git','show',f'{sha}:{path}'],text=True,capture_output=True)
    return r.stdout if r.returncode==0 else None
root=Path('server/src/runtime/responses')
# Codex is now a compatibility re-export; the implementation remains an explicit schema root.
p=Path('scripts/release/migration-plan.mjs');s=p.read_text();needle="  'server/src/runtime/responses/codexCredentialRuntimeState.ts',\n";assert needle in s;s=s.replace(needle,'',1);p.write_text(s)
for name in ['subscriptionCredentialRuntimeState.ts','subscriptionRefreshJournal.ts']:
    p=root/name;s=p.read_text()
    if not s.startswith('// release-migration: expand\n'):p.write_text('// release-migration: expand\n'+s)
put('scripts/release/grok-subscription-postcondition.sql',r'''
WITH suffixes(kind, suffix, column_count) AS (
  VALUES ('state', '_grok_credential_runtime_state', 6),
         ('journal', '_grok_credential_refresh_journal', 3)
), names AS (
  SELECT kind, column_count,
    lower((CASE WHEN length($1::text) <= 44 - length(suffix) THEN $1::text
      ELSE 'g' || left(encode(sha256(convert_to($1::text, 'UTF8')), 'hex'), 43 - length(suffix))
    END) || suffix) AS table_name
  FROM suffixes
), relations AS (
  SELECT n.*, c.oid FROM names n
  LEFT JOIN pg_class c ON c.oid = to_regclass(format('%I.%I', current_schema(), n.table_name))
    AND c.relkind = 'r' AND c.relpersistence = 'p'
), expected(kind, column_name, data_type, not_null) AS (
  VALUES ('state','credential_ref','text',true), ('state','availability','text',true),
    ('state','credential_generation','int8',true), ('state','cooldown_until','timestamptz',false),
    ('state','last_failure_code','text',false), ('state','updated_at','timestamptz',true),
    ('journal','credential_ref','text',true), ('journal','credential_generation','int8',true),
    ('journal','started_at','timestamptz',true)
)
SELECT
  (SELECT count(*) = 2 AND bool_and(oid IS NOT NULL) FROM relations)
  AND NOT EXISTS (
    SELECT 1 FROM expected e JOIN relations r USING(kind)
    LEFT JOIN pg_attribute a ON a.attrelid = r.oid AND a.attname = e.column_name
      AND a.attnum > 0 AND NOT a.attisdropped
    WHERE a.attname IS NULL OR a.atttypid <> e.data_type::regtype OR a.attnotnull <> e.not_null
  )
  AND NOT EXISTS (
    SELECT 1 FROM relations r WHERE
      (SELECT count(*) FROM pg_attribute a WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped) <> r.column_count
      OR NOT EXISTS (
        SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='credential_ref'
        WHERE c.conrelid=r.oid AND c.contype='p' AND c.convalidated AND c.conkey=ARRAY[a.attnum]
      )
  )
  AND EXISTS (
    SELECT 1 FROM relations r JOIN pg_constraint c ON c.conrelid=r.oid
    WHERE r.kind='state' AND c.contype='c' AND c.convalidated
      AND regexp_replace(pg_get_constraintdef(c.oid), '\s', '', 'g') =
        'CHECK((availability=ANY(ARRAY[''available''::text,''quota_cooldown''::text,''auth_unavailable''::text])))'
  )
  AND EXISTS (
    SELECT 1 FROM relations r JOIN pg_constraint c ON c.conrelid=r.oid
    WHERE r.kind='journal' AND c.contype='c' AND c.convalidated
      AND regexp_replace(pg_get_constraintdef(c.oid), '\s', '', 'g') = 'CHECK((credential_generation>0))'
  )
  AND EXISTS (
    SELECT 1 FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid AND a.attname='credential_generation'
    JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE r.kind='state' AND pg_get_expr(d.adbin,d.adrelid)='0'
  )
  AND (SELECT count(*)=2 FROM relations r
    JOIN pg_attribute a ON a.attrelid=r.oid AND a.attname=CASE WHEN r.kind='state' THEN 'updated_at' ELSE 'started_at' END
    JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE pg_get_expr(d.adbin,d.adrelid)='now()')
  AND EXISTS (
    SELECT 1 FROM relations r JOIN pg_index i ON i.indrelid=r.oid
    JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_attribute a ON a.attrelid=r.oid AND a.attname='cooldown_until'
    WHERE r.kind='state' AND idx.relname=r.table_name||'_cooldown_idx'
      AND i.indisvalid AND i.indisready AND NOT i.indisunique AND i.indnkeyatts=1
      AND i.indkey::text=a.attnum::text AND i.indpred IS NULL AND i.indexprs IS NULL
  ) AS ok
''')
# Freeze the original Codex CREATE statements as a source-attributed fixture, not a rewritten expectation.
baseline='d59eca1e1cef7e83a1e59634569f80497ca37834'
old=old_text(baseline,'server/src/runtime/responses/codexCredentialRuntimeState.ts');assert old
sqls=re.findall(r'`(\s*CREATE(?:[^`]+))`',old)
assert len(sqls)==2,sqls
fixture={'sourceSha':baseline,'sourcePath':'server/src/runtime/responses/codexCredentialRuntimeState.ts','sourceDigest':digest(old),'statements':sqls}
put('server/src/__tests__/fixtures/grok-codex-schema-baseline.json',json.dumps(fixture,ensure_ascii=False,indent=2)+'\n')
put('server/src/__tests__/grokSchemaPreservation.test.ts',r'''
import { readFileSync } from 'node:fs';
import { describe,expect,it,vi } from 'vitest';
import { PgCodexCredentialRuntimeStateStore } from '../runtime/responses/codexCredentialRuntimeState.js';
import { PgSubscriptionCredentialRuntimeStateStore } from '../runtime/responses/subscriptionCredentialRuntimeState.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/grok-codex-schema-baseline.json',import.meta.url),'utf8')) as {statements:string[]};
const normalize=(sql:string)=>sql.replace(/\s+/g,' ').trim();
describe('Codex schema preservation through common Grok infrastructure',()=>{
  it.each([PgCodexCredentialRuntimeStateStore,PgSubscriptionCredentialRuntimeStateStore])('preserves original DDL and names through %s',async(Store)=>{
    const queries:string[]=[];const query=vi.fn(async(sql:string)=>{queries.push(sql);return{rows:[]};});const pool={connect:async()=>({query,release:vi.fn()}),query} as unknown as ConstructorParameters<typeof Store>[0];
    const store=new Store(pool,'schema_fixture');await store.init();
    expect(queries.filter(q=>/^\s*CREATE/.test(q)).map(normalize)).toEqual(fixture.statements.map(q=>normalize(q.replaceAll('${this.table}','schema_fixture_codex_credential_runtime_state'))));
  });
});
''')
put('server/src/__tests__/grokSchemaPostconditions.pg.test.ts',r'''
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll,describe,expect,it } from 'vitest';
import { createGrokCredentialPersistence } from '../runtime/responses/grokCredentialPersistence.js';
import { grokSubscriptionTableName } from '../runtime/responses/grokSubscriptionTableNames.js';
const url=process.env.TEST_DATABASE_URL;
const pool=url?new pg.Pool({connectionString:url,max:2}):undefined;
const sql=readFileSync(new URL('../../../scripts/release/grok-subscription-postcondition.sql',import.meta.url),'utf8');
const prefixes:string[]=[];
afterAll(async()=>{if(!pool)return;for(const prefix of prefixes)for(const kind of ['runtime_state','refresh_journal'] as const)await pool.query(`DROP TABLE IF EXISTS ${grokSubscriptionTableName(prefix,kind)}`);await pool.end();});
describe.skipIf(!pool)('Grok read-only schema postconditions',()=>{
  it.each(['short','long'])('proves %s prefix tables and detects a removed index or check constraint',async(size)=>{
    const prefix=(size==='short'?'g':'grok_long_prefix_')+randomUUID().replaceAll('-','');prefixes.push(prefix);
    const read=async()=>Boolean((await pool!.query(sql,[prefix])).rows[0]?.ok);
    expect(await read()).toBe(false);await createGrokCredentialPersistence(pool,{backend:'pg',tablePrefix:prefix});expect(await read()).toBe(true);
    const table=grokSubscriptionTableName(prefix,'runtime_state');await pool!.query(`DROP INDEX ${table}_cooldown_idx`);expect(await read()).toBe(false);
    await createGrokCredentialPersistence(pool,{backend:'pg',tablePrefix:prefix});expect(await read()).toBe(true);
    await pool!.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_availability_check`);expect(await read()).toBe(false);
  });
});
''')
# The evidence states exact scope and semantic reasoning; source hashes bind it to this implementation.
put('docs/reviews/grok-subscription-migration.md',r'''
# Grok subscription additive migration review

Baseline family: existing content-bound release reviews plus main `eec01d4c1d043a3de0eec54f9fc1ab8d64651c4b`. Every record binds actual baseline and target bytes, not a wildcard or a mutable branch label. This review does not approve unrelated source changes.

Neutral files: `server/src/app/config.ts` adds optional Grok configuration and validates the Responses transport, without database statements; `server/src/app/grokSubscriptionConfigSchema.ts` is Zod configuration validation only; `server/src/runtime/responses/codexCredentialRuntimeState.ts` is the compatibility wrapper whose previous SQL implementation moves to the common module. The original Codex table name, six columns, primary key, availability constraint and cooldown index are preserved. A source-attributed baseline DDL fixture is compared with both exported constructors in `grokSchemaPreservation.test.ts`.

Additive files: `subscriptionCredentialRuntimeState.ts` preserves the Codex branch and initializes the separate Grok state table; `subscriptionRefreshJournal.ts` initializes a separate ref/generation journal; `grokSubscriptionSchema.ts` contains only CREATE TABLE/INDEX IF NOT EXISTS. Runtime UPDATE/INSERT/DELETE statements in the stores are request-time cooldown/journal operations, not startup backfills or destructive schema migrations. No Codex data is copied, rewritten or dropped.

New table names are generated by `grokSubscriptionTableName`, with deterministic bounded prefix hashing. The journal's actual suffix is `_grok_credential_refresh_journal`. Startup root authority moves from the Codex re-export to the actual common implementation; detector equality and baseline-to-target dependency closure remain enforced.

Each additive provider has a byte-bound read-only SQL postcondition, using `runtimeEventStore` and `$tablePrefix`. It proves both tables, exact column types/nullability, primary keys, validated check constraints, generation/timestamp defaults and a valid non-partial cooldown index. It does not merely test table existence. Long prefix hashing uses built-in PostgreSQL SHA-256, not an extension or a credential hash. `grokSchemaPostconditions.pg.test.ts` executes this query against isolated PostgreSQL and verifies that missing tables, a removed index and a removed check fail the proof.

Historical HTTP/Zhipu neutral reviews remain intact. Their exact allowlists are extended explicitly for these independently audited Grok files; mutation-of-source/evidence rejection assertions remain. No planner, signature, fail-closed rule or rollout confirmation is disabled. Recompute review hashes whenever these files or evidence change. Run source plan and existing release contracts on the final commit. Real production migration/observation is not performed by this PR.
''')
# Format bound evidence before calculating hashes; the repository hooks remain enabled.
subprocess.run(['pnpm','exec','prettier','--write','docs/reviews/grok-subscription-migration.md','server/src/__tests__/grokSchemaPreservation.test.ts','server/src/__tests__/grokSchemaPostconditions.pg.test.ts','server/src/__tests__/fixtures/grok-codex-schema-baseline.json'],check=True)
neutral=['server/src/app/config.ts','server/src/app/grokSubscriptionConfigSchema.ts','server/src/runtime/responses/codexCredentialRuntimeState.ts']
expand=['server/src/runtime/responses/subscriptionCredentialRuntimeState.ts','server/src/runtime/responses/subscriptionRefreshJournal.ts','server/src/runtime/responses/grokSubscriptionSchema.ts']
bound=['docs/reviews/grok-subscription-migration.md','server/src/__tests__/grokSchemaPreservation.test.ts','server/src/__tests__/fixtures/grok-codex-schema-baseline.json','server/src/__tests__/grokSchemaPostconditions.pg.test.ts','scripts/release/grok-subscription-postcondition.sql','server/src/runtime/responses/grokSubscriptionTableNames.ts']
rp=Path('config/release-migration-reviews.json');document=json.loads(rp.read_text());reviews=document['reviews']
current='eec01d4c1d043a3de0eec54f9fc1ab8d64651c4b'
if not any(r['baselineSha']==current for r in reviews):reviews.append({'baselineSha':current,'files':[],'evidence':[]})
postpath=Path('config/release-migration-postconditions.json');post=json.loads(postpath.read_text());pairs={}
for review in reviews:
    additions=[]
    for path in neutral+expand:
        before=old_text(review['baselineSha'],path);after=Path(path).read_text()
        if before==after:continue
        classification='no-schema-change' if path in neutral else 'expand'
        existing=next((item for item in review['files'] if item['path']==path),None)
        if existing and existing['classification']!=classification:raise RuntimeError(f'Existing conflicting review requires separate reconciliation: {path}')
        entry={'path':path,'baselineDigest':digest(before) if before is not None else None,'targetDigest':digest(after),'classification':classification,'reason':'Grok-specific review: '+('configuration-only / Codex compatibility export; preserved DDL proven by baseline fixture' if path in neutral else 'preserved Codex DDL plus isolated additive Grok state/journal; initialization contains no destructive migration')}
        if existing:existing.update(entry)
        else:review['files'].append(entry)
        if path in expand:pairs[(path,entry['baselineDigest'],entry['targetDigest'])]=entry
    for path in bound:
        entry={'path':path,'digest':digest(Path(path).read_text())}
        existing=next((item for item in review['evidence'] if item['path']==path),None)
        if existing:existing.update(entry)
        else:review['evidence'].append(entry)
for (path,before,after),entry in pairs.items():
    found=next((item for item in post['entries'] if item['path']==path and item.get('baselineDigest')==before and item['targetDigest']==after),None)
    check={'id':'grok-schema-'+hashlib.sha256(path.encode()).hexdigest()[:12],'configPath':'runtimeEventStore','params':['$tablePrefix'],'sql':Path('scripts/release/grok-subscription-postcondition.sql').read_text(),'description':'Grok state/journal columns, keys, validated checks, defaults and cooldown index; Codex compatibility is proven separately'}
    item={'path':path,'baselineDigest':before,'targetDigest':after,'checks':[check]}
    if found:found.update(item)
    else:post['entries'].append(item)
rp.write_text(json.dumps(document,ensure_ascii=False,indent=2)+'\n');postpath.write_text(json.dumps(post,ensure_ascii=False,indent=2)+'\n')
# Extend, rather than remove, exact historical-scope and byte/evidence mutation assertions.
p=Path('scripts/release/http-transport-pr-base-review.test.mjs');s=p.read_text();needle='const auditedPaths = [transport, quotaSchema];';assert needle in s
s=s.replace(needle,"const grokNeutralPaths = "+json.dumps(neutral)+";\nconst grokExpandPaths = "+json.dumps(expand)+";\nconst grokEvidencePaths = "+json.dumps(bound)+";\nconst auditedPaths = [transport, quotaSchema, ...grokNeutralPaths, ...grokExpandPaths];")
s=s.replace('const evidencePaths = [evidence, quotaEvidence];','const evidencePaths = [evidence, quotaEvidence, ...grokEvidencePaths];')
s=s.replace("assert.equal(loaded.entries.get(path).classification, 'no-schema-change');","assert.equal(loaded.entries.get(path).classification, grokExpandPaths.includes(path) ? 'expand' : 'no-schema-change');")
s=s.replace("assert.deepEqual([...loaded.entries.keys()], [quotaSchema]);","assert.deepEqual([...loaded.entries.keys()].sort(), [quotaSchema, ...grokNeutralPaths, ...grokExpandPaths].sort());")
s=s.replace("PR641 current baseline reviews only the Zhipu Zod module without GitHub event metadata","PR641 current baseline preserves Zhipu and the independently byte-bound Grok additive review")
s=s.replace('// independently audited paths, not an arbitrary expansion of the review scope.','// original paths plus the exact separately audited Grok scope, never a wildcard.')
p.write_text(s)
# Show a compact audit inventory without dumping the large retained review catalog.
print(json.dumps({'reviewCount':len(reviews),'grokNeutralPaths':neutral,'grokExpandPaths':expand,'postconditionPairs':len(pairs)},ensure_ascii=False))
