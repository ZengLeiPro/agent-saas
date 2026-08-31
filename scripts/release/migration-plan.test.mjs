import assert from 'node:assert/strict';
import test from 'node:test';
import { createMigrationPlan, isMigrationPath } from './migration-plan.mjs';

const BASELINE = 'a'.repeat(40);
const TARGET = 'b'.repeat(40);
const PATH = 'server/src/data/db/migrations.ts';

function gitFixture({ baselines, targets = {}, diffs = {}, nameStatus = `M\t${PATH}` }) {
  return (_command, args) => {
    if (args[0] === 'show') {
      const separator = args[1].indexOf(':');
      const revision = args[1].slice(0, separator);
      const path = args[1].slice(separator + 1);
      const tree = revision === BASELINE ? (baselines ?? targets) : targets;
      if (!(path in tree)) throw new Error(`missing ${revision}: ${path}`);
      return tree[path];
    }
    if (args[0] === 'ls-tree') {
      const tree = args[3] === BASELINE ? (baselines ?? targets) : targets;
      return Object.keys(tree).sort().join('\n');
    }
    if (args[0] === 'diff' && args.includes('--name-status')) return nameStatus;
    if (args[0] === 'diff') {
      const path = args.at(-1);
      if (!(path in diffs)) throw new Error(`missing diff: ${path}`);
      return diffs[path];
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };
}

function plan(source, diff, options = {}) {
  return createMigrationPlan({
    changedPaths: options.changedPaths ?? [PATH],
    baseline: BASELINE,
    target: TARGET,
    execFileSync: gitFixture({
      baselines: options.baselines,
      targets: options.targets ?? { [PATH]: source },
      diffs: options.diffs ?? { [PATH]: diff },
      nameStatus: options.nameStatus,
    }),
  });
}

function addedSourceDiff(source) {
  const lines = source.split('\n');
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}`;
}

function addedDiff(statement) {
  return addedSourceDiff(`// release-migration: expand\n${statement}`);
}

function sqlSource(statement) {
  return `// release-migration: expand\nconst migrationSql = ${JSON.stringify(statement)};`;
}

test('emits a deterministic baseline-bound no-migration plan', () => {
  const first = createMigrationPlan({
    changedPaths: ['web/src/App.tsx'],
    baseline: BASELINE,
    target: TARGET,
  });
  const second = createMigrationPlan({ changedPaths: [], baseline: BASELINE, target: TARGET });
  assert.equal(first.ok, true);
  assert.equal(first.migrationPlan.phase, 'none');
  assert.equal(first.migrationPlan.confirmation, 'not_required');
  assert.equal(first.migrationPlan.planDigest, second.migrationPlan.planDigest);
  assert.notEqual(
    first.migrationPlan.planDigest,
    createMigrationPlan({ changedPaths: [], baseline: 'c'.repeat(40), target: TARGET })
      .migrationPlan.planDigest,
  );
});

test('classifies destructive SQL in a module imported by the authoritative runner', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const imported = 'server/src/data/governance-schema/v22Migration.ts';
  const importedSource =
    '// release-migration: expand\nexport const governanceV22Statements = ["UPDATE records SET owner_id = NULL"];';
  const result = plan(importedSource, addedSourceDiff(importedSource), {
    changedPaths: [imported],
    targets: {
      [root]: "import { governanceV22Statements } from './v22Migration.js';",
      [imported]: importedSource,
    },
    diffs: { [imported]: addedSourceDiff(importedSource) },
    nameStatus: `M\t${imported}`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.migrationPlan.phase, 'expand');
  assert.match(result.blockingReasons.join('\n'), /contract or non-whitelisted/u);
});

test('fails closed for newly reachable side-effect-only module forms', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const danger = 'server/src/data/governance-schema/danger.ts';
  const dangerSource = "await db.query('DROP TABLE users');";
  for (const rootSource of [
    "import './danger.js';",
    "import {} from './danger.js';",
    "export {} from './danger.js';",
  ]) {
    const result = plan('', '', {
      changedPaths: [root],
      baselines: { [root]: 'export const statements = [];', [danger]: dangerSource },
      targets: { [root]: rootSource, [danger]: dangerSource },
      diffs: { [root]: addedSourceDiff(rootSource) },
      nameStatus: `M\t${root}`,
    });
    assert.equal(result.ok, false, rootSource);
    assert.equal(result.migrationPlan.phase, 'expand', rootSource);
    assert.match(result.blockingReasons.join('\n'), /lacks a standalone/u);
    assert.match(result.blockingReasons.join('\n'), /dynamic, custom-query/u);
  }
});

test('fails closed when a named import dependency gains top-level executable SQL', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const danger = 'server/src/data/governance-schema/danger.ts';
  const rootSource = "import { marker } from './danger.js';\nexport { marker };";
  const baselineDanger = 'export const marker = 1;';
  const targetDanger = "await db.query('DROP TABLE users');\nexport const marker = 1;";
  const result = plan(targetDanger, addedSourceDiff("await db.query('DROP TABLE users');"), {
    changedPaths: [danger],
    baselines: { [root]: rootSource, [danger]: baselineDanger },
    targets: { [root]: rootSource, [danger]: targetDanger },
    diffs: { [danger]: addedSourceDiff("await db.query('DROP TABLE users');") },
    nameStatus: `M\t${danger}`,
  });
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /danger\.ts/u);
  assert.match(result.blockingReasons.join('\n'), /dynamic, custom-query/u);
});

test('fails closed when an aliased called runtime provider gains destructive SQL', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const barrel = 'server/src/data/governance-schema/providers/index.ts';
  const provider = 'server/src/data/governance-schema/providers/run.ts';
  const rootSource =
    "import * as providers from './providers/index.js';\nconst { runMigration } = providers;\nconst execute = runMigration;\nexport async function migrate(db) { await execute(db); }";
  const barrelSource = "export { run as runMigration } from './run.js';";
  const baselineProvider =
    "export async function run(db) { await db.query('CREATE TABLE users(id text)'); }";
  const targetProvider = "export async function run(db) { await db.query('DROP TABLE users'); }";
  const result = plan(targetProvider, addedSourceDiff("await db.query('DROP TABLE users');"), {
    changedPaths: [provider],
    baselines: {
      [root]: rootSource,
      [barrel]: barrelSource,
      [provider]: baselineProvider,
    },
    targets: {
      [root]: rootSource,
      [barrel]: barrelSource,
      [provider]: targetProvider,
    },
    diffs: { [provider]: addedSourceDiff("await db.query('DROP TABLE users');") },
    nameStatus: `M\t${provider}`,
  });
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /run\.ts/u);
  assert.match(result.blockingReasons.join('\n'), /dynamic, custom-query/u);
});

test('fails closed for dynamic import, require, and createRequire loaders', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  for (const source of [
    "export async function migrate() { await import('./provider.js'); }",
    "export async function migrate() { require('./provider.js'); }",
    "export async function migrate() { createRequire(import.meta.url)('./provider.js'); }",
    "export async function migrate() { const load = createRequire(import.meta.url); load('./provider.js'); }",
    "import * as moduleApi from 'node:module';\nexport async function migrate() { const load = moduleApi.createRequire(import.meta.url); load('./provider.js'); }",
    "import * as moduleApi from 'node:module';\nconst { createRequire: makeRequire } = moduleApi;\nexport async function migrate() { const load = makeRequire(import.meta.url); load('./provider.js'); }",
    "import * as moduleApi from 'node:module';\nconst ns = moduleApi;\nconst { createRequire: makeRequire } = ns;\nexport async function migrate() { const load = makeRequire(import.meta.url); load('./provider.js'); }",
    "import * as moduleApi from 'node:module';\nexport async function migrate() { const load = moduleApi['createRequire'](import.meta.url); load('./provider.js'); }",
  ]) {
    const result = plan(source, addedSourceDiff(source), {
      changedPaths: [root],
      baselines: { [root]: 'export async function migrate() {}' },
      targets: { [root]: source },
      diffs: { [root]: addedSourceDiff(source) },
      nameStatus: `M\t${root}`,
    });
    assert.equal(result.ok, false, source);
    assert.match(result.blockingReasons.join('\n'), /closure could not be proven/u, source);
  }
});

test('fails closed for class evaluation side effects in a runtime dependency', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const danger = 'server/src/data/governance-schema/danger.ts';
  const rootSource = "import { marker } from './danger.js';\nexport { marker };";
  for (const executable of [
    "class X extends (db.query('DROP TABLE users'), Base) {}",
    'class X extends globalThis.registry.Base {}',
    "class X { [db.query('DROP TABLE users')]() {} }",
    'class X { [dangerKey]() {} }',
    "namespace N { db.query('DROP TABLE users'); }",
  ]) {
    const baselineDanger = 'export const marker = 1;';
    const targetDanger = `${executable}\nexport const marker = 1;`;
    const result = plan(targetDanger, addedSourceDiff(executable), {
      changedPaths: [danger],
      baselines: { [root]: rootSource, [danger]: baselineDanger },
      targets: { [root]: rootSource, [danger]: targetDanger },
      diffs: { [danger]: addedSourceDiff(executable) },
      nameStatus: `M\t${danger}`,
    });
    assert.equal(result.ok, false, executable);
    assert.match(result.blockingReasons.join('\n'), /danger\.ts/u);
  }
});

test('does not follow type-only import or re-export edges at runtime', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const danger = 'server/src/data/governance-schema/danger.ts';
  const dangerSource = "await db.query('DROP TABLE users');\nexport type T = string;";
  for (const rootSource of [
    "import { type T } from './danger.js';\nexport type { T };",
    "export { type T } from './danger.js';",
  ]) {
    const result = plan('', '', {
      changedPaths: [danger],
      baselines: { [root]: rootSource, [danger]: 'export type T = string;' },
      targets: { [root]: rootSource, [danger]: dangerSource },
      diffs: { [danger]: addedSourceDiff("await db.query('DROP TABLE users');") },
      nameStatus: `M\t${danger}`,
    });
    assert.equal(result.ok, true, rootSource);
    assert.equal(result.migrationPlan.phase, 'none', rootSource);
  }
});

test('reprocesses a previously visited binding when it later becomes side-effect reachable', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const bridge = 'server/src/data/governance-schema/bridge.ts';
  const danger = 'server/src/data/governance-schema/danger.ts';
  const rootSource = `import * as danger from './danger.js';\nimport { sql } from './bridge.js';\nexport { sql };`;
  const bridgeSource = `// release-migration: expand\nimport './danger.js';\nexport const sql = 'CREATE TABLE safe(id text)';`;
  const dangerSource = "await db.query('DROP TABLE users');";
  const result = plan(rootSource, addedSourceDiff(rootSource), {
    changedPaths: [root],
    baselines: {
      [root]: 'export const statements = [];',
      [bridge]: bridgeSource,
      [danger]: dangerSource,
    },
    targets: { [root]: rootSource, [bridge]: bridgeSource, [danger]: dangerSource },
    diffs: { [root]: addedSourceDiff(rootSource) },
    nameStatus: `M\t${root}`,
  });
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /danger\.ts/u);
});

test('traverses an ordinary barrel before classifying an explicitly marked provider', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const barrel = 'server/src/data/governance-schema/providers/index.ts';
  const provider = 'server/src/data/governance-schema/providers/v34Provider.ts';
  const providerSource =
    '// release-migration: expand\nexport const v34Statements = ["UPDATE users SET role = NULL"];';
  const result = plan(providerSource, addedSourceDiff(providerSource), {
    changedPaths: [provider],
    targets: {
      [root]: "import { v34Statements } from './providers/index.js';",
      [barrel]: "export { v34Statements } from './v34Provider.js';",
      [provider]: providerSource,
    },
    diffs: { [provider]: addedSourceDiff(providerSource) },
    nameStatus: `M\t${provider}`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.migrationPlan.phase, 'expand');
  assert.match(result.blockingReasons.join('\n'), /contract or non-whitelisted/u);
});

test('classifies an unchanged provider when a changed barrel makes it newly reachable', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const barrel = 'server/src/data/governance-schema/providers/index.ts';
  const provider = 'server/src/data/governance-schema/providers/v34Provider.ts';
  const rootSource = "import { v34Statements } from './providers/index.js';";
  const providerSource =
    '// release-migration: expand\nexport const v34Statements = ["UPDATE users SET role = NULL"];';
  const result = plan('', '', {
    changedPaths: [barrel],
    baselines: {
      [root]: rootSource,
      [barrel]: 'export const v34Statements = [];',
      [provider]: providerSource,
    },
    targets: {
      [root]: rootSource,
      [barrel]: "export { v34Statements } from './v34Provider.js';",
      [provider]: providerSource,
    },
    diffs: {},
    nameStatus: `M\t${barrel}`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.migrationPlan.phase, 'expand');
  assert.match(result.blockingReasons.join('\n'), /contract or non-whitelisted/u);
});

test('classifies a newly reachable declarative SQL provider without voluntary metadata', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const barrel = 'server/src/data/governance-schema/providers/index.ts';
  const provider = 'server/src/data/governance-schema/providers/v34Provider.ts';
  const rootSource = "import { statements } from './providers/index.js';";
  const providerSource =
    'export interface MigrationProvider { statements: string[] }\n' +
    'export const statements = ["UPDATE users SET role = NULL"], run = () => undefined;\n' +
    'export const maintenanceCommands = ["VACUUM users"];';
  const result = plan('', '', {
    changedPaths: [barrel],
    baselines: {
      [root]: rootSource,
      [barrel]: 'export const statements = [];',
      [provider]: providerSource,
    },
    targets: {
      [root]: rootSource,
      [barrel]: "export { statements } from './v34Provider.js';",
      [provider]: providerSource,
    },
    diffs: {},
    nameStatus: `M\t${barrel}`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.migrationPlan.phase, 'expand');
  assert.match(result.blockingReasons.join('\n'), /lacks a standalone/u);
  assert.match(result.blockingReasons.join('\n'), /contract or non-whitelisted/u);
});

for (const providerCase of [
  {
    label: 'local alias',
    source: 'const steps = ["INSERT INTO users(id) VALUES (1)"]; export { steps as statements };',
    barrelExport: "export { statements } from './v34Provider.js';",
  },
  {
    label: 'default export',
    source: 'export default ["INSERT INTO users(id) VALUES (1)"];',
    barrelExport: "export { default as statements } from './v34Provider.js';",
  },
]) {
  test(`tracks ${providerCase.label} through a barrel without provider naming or metadata`, () => {
    const root = 'server/src/data/governance-schema/migrations.ts';
    const barrel = 'server/src/data/governance-schema/providers/index.ts';
    const provider = 'server/src/data/governance-schema/providers/v34Provider.ts';
    const rootSource = "import { statements } from './providers/index.js';";
    const result = plan('', '', {
      changedPaths: [barrel],
      baselines: {
        [root]: rootSource,
        [barrel]: 'export const statements = [];',
        [provider]: providerCase.source,
      },
      targets: {
        [root]: rootSource,
        [barrel]: providerCase.barrelExport,
        [provider]: providerCase.source,
      },
      diffs: {},
      nameStatus: `M\t${barrel}`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.migrationPlan.phase, 'expand');
    assert.match(result.blockingReasons.join('\n'), /lacks a standalone/u);
    assert.match(result.blockingReasons.join('\n'), /contract or non-whitelisted/u);
  });
}

for (const statement of [
  'VACUUM users;',
  'ANALYZE users;',
  'BEGIN;',
  'SET ROLE app_user;',
  "DO LANGUAGE plpgsql 'BEGIN NULL; END';",
  'UPDATE users u SET role = NULL;',
  'UPDATE ONLY users * AS u SET role = NULL;',
  'EXPLAIN ANALYZE INSERT INTO users(id) VALUES (1);',
  'PREPARE add_user AS INSERT INTO users(id) VALUES (1);',
  'WITH incoming(id) AS (VALUES (1)) INSERT INTO users(id) SELECT id FROM incoming;',
  'SELECT destructive_function();',
  'VALUES (destructive_function());',
]) {
  test(`detects standalone PostgreSQL command in an unmarked reachable provider: ${statement}`, () => {
    const root = 'server/src/data/governance-schema/migrations.ts';
    const barrel = 'server/src/data/governance-schema/providers/index.ts';
    const provider = 'server/src/data/governance-schema/providers/maintenanceProvider.ts';
    const rootSource = "import { statements } from './providers/index.js';";
    const providerBinding = statement.startsWith('UPDATE')
      ? 'migrationStatement'
      : 'maintenanceCommands';
    const providerSource = statement.startsWith('UPDATE')
      ? `export const ${providerBinding} = ${JSON.stringify(statement)};`
      : `export const ${providerBinding} = [${JSON.stringify(statement)}];`;
    const result = plan('', '', {
      changedPaths: [barrel],
      baselines: {
        [root]: rootSource,
        [barrel]: 'export const statements = [];',
        [provider]: providerSource,
      },
      targets: {
        [root]: rootSource,
        [barrel]: `export { ${providerBinding} as statements } from './maintenanceProvider.js';`,
        [provider]: providerSource,
      },
      diffs: {},
      nameStatus: `M\t${barrel}`,
    });
    assert.equal(result.ok, false);
    assert.equal(result.migrationPlan.phase, 'expand');
    assert.match(result.blockingReasons.join('\n'), /lacks a standalone/u);
  });
}

test('fails closed when a changed barrel disconnects an unchanged provider', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const barrel = 'server/src/data/governance-schema/providers/index.ts';
  const provider = 'server/src/data/governance-schema/providers/v34Provider.ts';
  const rootSource = "import { v34Statements } from './providers/index.js';";
  const providerSource = sqlSource('CREATE TABLE IF NOT EXISTS governance_v34(id text);');
  const result = plan('', '', {
    changedPaths: [barrel],
    baselines: {
      [root]: rootSource,
      [barrel]: "export { v34Statements } from './v34Provider.js';",
      [provider]: providerSource,
    },
    targets: {
      [root]: rootSource,
      [barrel]: 'export const v34Statements = [];',
      [provider]: providerSource,
    },
    diffs: {},
    nameStatus: `M\t${barrel}`,
  });
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /no longer reachable/u);
});

test('fails closed when a barrel-backed provider is deleted or renamed', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const barrel = 'server/src/data/governance-schema/providers/index.ts';
  const oldProvider = 'server/src/data/governance-schema/providers/v34Provider.ts';
  const newProvider = 'server/src/data/governance-schema/providers/v35Provider.ts';
  const source = sqlSource('CREATE TABLE IF NOT EXISTS governance_v34(id text);');
  const baselineTree = {
    [root]: "import { statements } from './providers/index.js';",
    [barrel]: "export { statements } from './v34Provider.js';",
    [oldProvider]: source,
  };
  const removed = plan('', '', {
    changedPaths: [oldProvider],
    baselines: baselineTree,
    targets: { [root]: baselineTree[root], [barrel]: 'export const statements = [];' },
    diffs: {},
    nameStatus: `D\t${oldProvider}`,
  });
  assert.equal(removed.ok, false);
  assert.match(removed.blockingReasons.join('\n'), /removal or rename/u);

  const renamed = plan(source, addedSourceDiff(source), {
    changedPaths: [newProvider],
    baselines: baselineTree,
    targets: {
      [root]: baselineTree[root],
      [barrel]: "export { statements } from './v35Provider.js';",
      [newProvider]: source,
    },
    diffs: { [newProvider]: addedSourceDiff(source) },
    nameStatus: `R100\t${oldProvider}\t${newProvider}`,
  });
  assert.equal(renamed.ok, false);
  assert.match(renamed.blockingReasons.join('\n'), /removal or rename/u);
});

test('does not classify ordinary logger or store dependencies behind a barrel', () => {
  const root = 'server/src/data/groups/migrate.ts';
  const barrel = 'server/src/data/groups/runtime/index.ts';
  const logger = 'server/src/data/groups/runtime/logger.ts';
  const store = 'server/src/data/groups/runtime/store.ts';
  const loggerSource =
    'export const dataLogger = {}; export const migrationStatus = "UPDATE completed"; ' +
    'export const queries = ["SELECT * FROM logs", "SELECT count(*) FROM logs"];';
  const storeSource = "export const loadGroup = () => db.query('SELECT * FROM groups');";
  const result = plan('', '', {
    changedPaths: [logger, store],
    targets: {
      [root]: "import { dataLogger, queries, loadGroup } from './runtime/index.js';",
      [barrel]:
        "export { dataLogger, queries } from './logger.js'; export { loadGroup } from './store.js';",
      [logger]: loggerSource,
      [store]: storeSource,
    },
    diffs: {
      [logger]: addedSourceDiff(loggerSource),
      [store]: addedSourceDiff(storeSource),
    },
    nameStatus: `M\t${logger}\nM\t${store}`,
  });
  assert.equal(result.ok, true);
  assert.equal(result.migrationPlan.phase, 'none');
});

test('classifies destructive SQL in a directly executed context migration', () => {
  const contextPath = 'server/src/context/phase23/migration.ts';
  const source =
    '// release-migration: expand\nexport const contextStatements = ["UPDATE records SET owner_id = NULL"];';
  const result = plan(source, addedSourceDiff(source), {
    changedPaths: [contextPath],
    targets: { [contextPath]: source },
    diffs: { [contextPath]: addedSourceDiff(source) },
    nameStatus: `M\t${contextPath}`,
  });
  assert.equal(result.ok, false);
  assert.equal(result.migrationPlan.phase, 'expand');
  assert.match(result.blockingReasons.join('\n'), /contract or non-whitelisted/u);
});

test('does not classify unrelated runtime dependencies imported by a data migration', () => {
  const root = 'server/src/data/groups/migrate.ts';
  const logger = 'server/src/utils/logger.ts';
  const loggerSource = 'export const dataLogger = {};';
  const result = plan(loggerSource, addedSourceDiff(loggerSource), {
    changedPaths: [logger],
    targets: {
      [root]: "import { dataLogger } from '../../utils/logger.js';",
      [logger]: loggerSource,
    },
    diffs: { [logger]: addedSourceDiff(loggerSource) },
    nameStatus: `M\t${logger}`,
  });
  assert.equal(result.ok, true);
  assert.equal(result.migrationPlan.phase, 'none');
});

test('recognizes every authoritative repository migration entry', () => {
  for (const path of [
    'server/src/data/db/migrations.ts',
    'server/src/data/governance-schema/migrations.ts',
    'server/src/data/context/migration.ts',
    'server/src/context/store/migration.ts',
    'server/src/context/phase23/migration.ts',
    'server/src/context/phase4/migration.ts',
    'server/src/context/lifecycle/migration.ts',
    'server/src/data/groups/migrate.ts',
    'server/src/data/skills/migrate.ts',
    'server/scripts/migrate-events-file-to-pg.mts',
    'server/scripts/migrate-platform-tenant-pantheon.mts',
    'scripts/migrations/001-expand.sql',
  ]) {
    assert.equal(isMigrationPath(path), true, path);
  }
  assert.equal(isMigrationPath('server/src/data/users/store.ts'), false);
});

test('requires standalone expand metadata and accepts only whitelisted expand statements', () => {
  const source = sqlSource('CREATE TABLE IF NOT EXISTS safe_addition(id text);');
  const result = plan(source, addedSourceDiff(source));
  assert.equal(result.ok, true);
  assert.equal(result.migrationPlan.phase, 'expand');
  assert.equal(result.migrationPlan.confirmation, 'required_after_observation');

  for (const valid of [
    'CREATE UNIQUE INDEX CONCURRENTLY safe_idx ON safe_addition(id);',
    'CREATE SEQUENCE IF NOT EXISTS safe_sequence;',
    'CREATE TABLE safe_identity(id bigint GENERATED ALWAYS AS IDENTITY);',
    'CREATE TABLE safe_generated(first text, lowered text GENERATED ALWAYS AS (lower(first)) STORED);',
    'ALTER TABLE safe_addition ADD COLUMN note numeric(10, 2);',
    "ALTER TABLE safe_addition ADD COLUMN escaped text DEFAULT E'foo\\\',bar; -- DROP';",
    "ALTER TABLE safe_addition ADD COLUMN quoted text DEFAULT 'DROP, SELECT;';",
    'ALTER TABLE safe_addition ADD COLUMN dollar text DEFAULT $$DROP, SELECT;$$;',
    'ALTER /* outer /* nested DROP, SELECT; */ comment */ TABLE safe_addition ADD COLUMN nested text;',
    "ALTER TABLE safe_addition ADD CONSTRAINT safe_check CHECK (id <> '');",
    'ALTER TABLE safe_addition ADD CONSTRAINT safe_owner CHECK (owner_id IS NOT NULL);',
    'ALTER TABLE safe_addition VALIDATE CONSTRAINT safe_check;',
  ]) {
    const validSource = sqlSource(valid);
    const validResult = plan(validSource, addedSourceDiff(validSource));
    assert.equal(validResult.ok, true, valid);
  }
});

test('does not accept expand metadata inside PostgreSQL dollar-quoted bodies', () => {
  for (const body of [
    '$$\n-- release-migration: expand\n$$',
    '$body$\n-- release-migration: expand\n$body$',
    '$标签$\n-- release-migration: expand\n$标签$',
    '$😀$\n-- release-migration: expand\n$😀$',
  ]) {
    const path = 'server/src/data/db/migrations/001.sql';
    const source = `ALTER TABLE records ADD COLUMN note text DEFAULT ${body};`;
    const result = plan(source, addedSourceDiff(source), {
      changedPaths: [path],
      targets: { [path]: source },
      diffs: { [path]: addedSourceDiff(source) },
      nameStatus: `A\t${path}`,
    });
    assert.equal(result.ok, false, body);
    assert.match(result.blockingReasons.join('\n'), /lacks a standalone/u);
  }
});

test('does not treat a dollar tag inside an SQL identifier as a quoted body', () => {
  const path = 'server/src/data/db/migrations/001.sql';
  for (const table of ['foo$tag$', '表$tag$']) {
    const source = `-- release-migration: expand\nCREATE TABLE ${table}(id text);`;
    const result = plan(source, addedSourceDiff(source), {
      changedPaths: [path],
      targets: { [path]: source },
      diffs: { [path]: addedSourceDiff(source) },
      nameStatus: `A\t${path}`,
    });
    assert.equal(result.ok, true, table);
  }
});

test('rejects quoted and high-byte ALTER function calls in SQL files', () => {
  const path = 'server/src/data/db/migrations/001.sql';
  for (const statement of [
    'ALTER TABLE records ADD COLUMN x bigint DEFAULT "nextval"();',
    'ALTER TABLE records ADD CONSTRAINT safe CHECK (public."danger"(id));',
    'ALTER TABLE records ADD COLUMN x bigint DEFAULT 危险函数();',
    'ALTER TABLE records ADD COLUMN x bigint DEFAULT 😀();',
  ]) {
    const source = `-- release-migration: expand\n${statement}`;
    const result = plan(source, addedSourceDiff(source), {
      changedPaths: [path],
      targets: { [path]: source },
      diffs: { [path]: addedSourceDiff(source) },
      nameStatus: `A\t${path}`,
    });
    assert.equal(result.ok, false, statement);
    assert.match(result.blockingReasons.join('\n'), /contract or non-whitelisted/u);
  }
});

test('does not accept metadata embedded in strings or executable code', () => {
  for (const source of [
    "const note = 'release-migration: expand';\nCREATE TABLE safe_addition(id text);",
    'const note = `release-migration: expand`;\nCREATE TABLE safe_addition(id text);',
    'const note = `\n// release-migration: expand\n`;\nCREATE TABLE safe_addition(id text);',
    'run("// release-migration: expand");\nCREATE TABLE safe_addition(id text);',
  ]) {
    const result = plan(source, addedSourceDiff(source));
    assert.equal(result.ok, false);
    assert.match(result.blockingReasons.join('\n'), /standalone/u);
  }
});

for (const statement of [
  'ALTER TABLE records RENAME COLUMN old_name TO new_name;',
  'ALTER TABLE records DROP CONSTRAINT records_owner_fkey;',
  'ALTER TABLE records ALTER COLUMN owner_id SET NOT NULL;',
  'ALTER TABLE records ALTER COLUMN owner_id TYPE uuid;',
  "ALTER TABLE records ADD COLUMN x text, ALTER COLUMN status SET DEFAULT 'x';",
  'ALTER INDEX records_owner_idx SET (fillfactor=70);',
  'ALTER SEQUENCE records_id_seq RESTART WITH 100;',
  'REASSIGN OWNED BY old_role TO new_role;',
  'INSERT INTO records(id) VALUES (1);',
  "INSERT INTO records(id) VALUES ('1') ON CONFLICT DO NOTHING;",
  'INSERT INTO audit(id) VALUES (destructive_function()) ON CONFLICT DO NOTHING;',
  'CREATE TABLE copied AS VALUES (1);',
  'CREATE TABLE copied AS TABLE source_records;',
  'CREATE TABLE safe(id int)\n\\g\n\\i /tmp/evil.sql',
  'CREATE TABLE safe(id int)\n\\g\n\\! touch /tmp/owned',
  'CREATE TABLE safe_addition(id int); REASSIGN OWNED BY old_role TO new_role;',
  "CREATE TABLE safe_addition(id int); COMMENT ON TABLE safe_addition IS 'unsafe tail';",
  "CREATE TABLE safe(note text DEFAULT E'foo\\'; -- x'); REASSIGN OWNED BY old_role TO new_role;",
  'CREATE OR REPLACE VIEW active_records AS SELECT * FROM records;',
  'CREATE FUNCTION unsafe_migration() RETURNS void AS $$ BEGIN NULL; END $$ LANGUAGE plpgsql;',
  'DROP INDEX records_owner_idx;',
  'DROP VIEW active_records;',
  'TRUNCATE records;',
  'DELETE FROM records;',
  'UPDATE ONLY records AS current SET owner_id = null;',
  'INSERT INTO records(id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id=excluded.id;',
  'MERGE /* routing */ INTO records USING incoming ON records.id=incoming.id WHEN MATCHED THEN UPDATE SET id=incoming.id;',
  'REPLACE INTO records(id) VALUES (1);',
  'ALTER TABLE records ADD COLUMN owner_id text NOT NULL;',
  "ALTER TABLE records ADD COLUMN x bigint DEFAULT nextval('shared_seq');",
  'ALTER TABLE records ADD CONSTRAINT safe CHECK (destructive_function(id));',
  `ALTER TABLE records ADD COLUMN x bigint DEFAULT "nextval"('shared_seq');`,
  'ALTER TABLE records ADD CONSTRAINT safe CHECK ("destructive_function"(id));',
  'ALTER TABLE records ADD COLUMN x bigint DEFAULT 危险函数();',
  'ALTER TABLE records ADD CONSTRAINT safe CHECK (public.危险函数(id));',
  "ALTER TABLE records ADD COLUMN note text DEFAULT '--' NOT NULL;",
]) {
  test(`fails closed for contract or non-whitelisted operation: ${statement}`, () => {
    const result = plan(`// release-migration: expand\n${statement}`, addedDiff(statement));
    assert.equal(result.ok, false);
    assert.match(result.blockingReasons.join('\n'), /contract or non-whitelisted/u);
  });
}

for (const statement of [
  'EXECUTE dynamic_statement;',
  "SELECT format('ALTER TABLE %I', name);",
  'prisma.$executeRawUnsafe(statement);',
  'sql.raw(statement);',
  'DO $$ BEGIN EXECUTE statement; END $$;',
  "await db.query('UP'+'DATE records SET x=NULL');",
  'await db.query(`UP${verb}DATE groups SET role=NULL`);',
  'await db.query(statement);',
  "await db.query('CREATE TABLE unsafe(id text)');",
  'await customQuery(statement);',
  'await prisma.group.deleteMany();',
  'await migrationRunner(statement);',
  'Reflect.apply(db.query, db, [statement]);',
  "import db from './arbitrary-runner.mjs';\nawait db.query('CREATE TABLE x(id text)');",
  "class db { static query = migrationRunner }\nawait db.query('CREATE TABLE x(id text)');",
  "await db['query'](['UP', 'DATE records SET x=NULL'].join(''));",
  'await client.send(statement);',
  "await custom.query('CREATE TABLE unsafe(id text)');",
  '(0, db.query)(statement);',
  'const run = db.query; await run(statement);',
  'const run = db.query;',
  'export const execute = () => statement;',
  'db.query;',
  "if (shouldRun) db.query('CREATE TABLE unsafe(id text)');",
  'const hiddenSql = `UP${verb}DATE records SET x=NULL`;',
  'CALL custom_migration();',
  'WITH changed AS (SELECT 1) INSERT INTO records(id) SELECT * FROM changed;',
]) {
  test(`fails closed for dynamic, custom-query, or ambiguous SQL: ${statement}`, () => {
    const result = plan(`// release-migration: expand\n${statement}`, addedDiff(statement));
    assert.equal(result.ok, false);
    assert.match(
      result.blockingReasons.join('\n'),
      /dynamic, custom-query, or lexically ambiguous/u,
    );
  });
}

test('rejects executable calls even when the SQL argument is static', () => {
  const source =
    "// release-migration: expand\nawait db.query('CREATE TABLE IF NOT EXISTS safe_addition(id text);');";
  const result = plan(source, addedSourceDiff(source));
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /dynamic, custom-query, or lexically ambiguous/u);
});

test('rejects calls inserted inside pre-existing control flow or call syntax', () => {
  const insideIf = [
    '// release-migration: expand',
    'if (shouldRun) {',
    "  await db.query('CREATE TABLE unsafe(id text)');",
    '}',
  ].join('\n');
  const insideIfResult = plan(
    insideIf,
    "@@ -2,0 +3,1 @@\n+  await db.query('CREATE TABLE unsafe(id text)');",
  );
  assert.equal(insideIfResult.ok, false);

  const addedArgument = [
    '// release-migration: expand',
    'await db.query(',
    "  'CREATE TABLE unsafe(id text)',",
    ');',
  ].join('\n');
  const addedArgumentResult = plan(
    addedArgument,
    "@@ -2,0 +3,1 @@\n+  'CREATE TABLE unsafe(id text)',",
  );
  assert.equal(addedArgumentResult.ok, false);
});

test('decodes escaped static literals before SQL classification', () => {
  for (const statement of [
    'await db.query("\\x55PDATE records SET x=NULL");',
    'const hiddenSql = "\\u0055PDATE records SET x=NULL";',
  ]) {
    const result = plan(`// release-migration: expand\n${statement}`, addedDiff(statement));
    assert.equal(result.ok, false);
    assert.match(
      result.blockingReasons.join('\n'),
      /contract or non-whitelisted|dynamic, custom-query/u,
    );
  }
});

test('fails closed when baseline migration lines are removed or replaced', () => {
  const result = plan(
    '// release-migration: expand\nCREATE TABLE replacement(id text);',
    '@@ -1,2 +1,2 @@\n-CREATE TABLE original(id text);\n+// release-migration: expand\n+CREATE TABLE replacement(id text);',
  );
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /deletes or replaces baseline content/u);
});

test('fails closed for a renamed migration even when only the target path was classified', () => {
  const oldPath = 'server/src/data/groups/migrate.ts';
  const newPath = 'server/src/data/groups/migrations.ts';
  const source = sqlSource('CREATE TABLE IF NOT EXISTS groups_v2(id text);');
  const diff = addedSourceDiff(source);
  const result = plan(source, diff, {
    changedPaths: [newPath],
    targets: { [newPath]: source },
    diffs: { [newPath]: diff },
    nameStatus: `R100\t${oldPath}\t${newPath}`,
  });
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /removal or rename/u);
});

test('fails closed for removed migrations and unreadable baseline comparisons', () => {
  const removed = createMigrationPlan({
    changedPaths: [PATH],
    baseline: BASELINE,
    target: TARGET,
    execFileSync: gitFixture({ targets: {}, diffs: {}, nameStatus: `D\t${PATH}` }),
  });
  assert.equal(removed.ok, false);
  assert.match(removed.blockingReasons.join('\n'), /separate contract release/u);

  const noDiff = createMigrationPlan({
    changedPaths: [PATH],
    baseline: BASELINE,
    target: TARGET,
    execFileSync: gitFixture({
      targets: { [PATH]: '// release-migration: expand' },
      diffs: {},
      nameStatus: `M\t${PATH}`,
    }),
  });
  assert.equal(noDiff.ok, false);
  assert.match(noDiff.blockingReasons.join('\n'), /could not be compared/u);
});
