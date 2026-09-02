import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

test('tracks imported callbacks through aliases, descriptor factories, class fields, and re-exports', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const barrel = 'server/src/data/governance-schema/providers/index.ts';
  const provider = 'server/src/data/governance-schema/providers/run.ts';
  const baselineProvider = 'export async function run(_db) {}';
  const targetProvider = "export async function run(db) { await db.query('DROP TABLE users'); }";
  for (const callbackCase of [
    {
      label: 'array map callback',
      rootSource: "import { run } from './providers/run.js';\n[db].map(run);",
      extraTree: {},
    },
    {
      label: 'static class field callable alias',
      rootSource:
        "import { run } from './providers/run.js';\nclass Runner { static execute = run; }\nRunner.execute(db);",
      extraTree: {},
    },
    {
      label: 'custom higher-order registrar callback from an empty baseline',
      rootSource: "import { run } from './providers/run.js';\nregisterMigration(run);",
      extraTree: {},
    },
    {
      label: 'custom constructor callback from an empty baseline',
      rootSource: "import { run } from './providers/run.js';\nnew MigrationRegistrar(run);",
      extraTree: {},
    },
    {
      label: 'object property callback from an empty baseline',
      rootSource:
        "import { run } from './providers/run.js';\nregisterMigration({ callback: run });",
      extraTree: {},
    },
    {
      label: 'object arrow callback wrapper from an empty baseline',
      rootSource:
        "import { run } from './providers/run.js';\nregisterMigration({ callback: () => run });",
      extraTree: {},
    },
    {
      label: 'object function callback wrapper from an empty baseline',
      rootSource:
        "import { run } from './providers/run.js';\nregisterMigration({ callback: function callback() { return run; } });",
      extraTree: {},
    },
    {
      label: 'object shorthand and spread callbacks from an empty baseline',
      rootSource:
        "import { run } from './providers/run.js';\nregisterMigration({ run, ...{ callback: run } });",
      extraTree: {},
    },
    {
      label: 'computed object property callback from an empty baseline',
      rootSource:
        "import { run } from './providers/run.js';\nregisterMigration({ ['callback']: run });",
      extraTree: {},
    },
    {
      label: 'object method callback from an empty baseline',
      rootSource:
        "import { run } from './providers/run.js';\nregisterMigration({ callback() { return run; } });",
      extraTree: {},
    },
    {
      label: 'object accessor callback from an empty baseline',
      rootSource:
        "import { run } from './providers/run.js';\nregisterMigration({ get callback() { return run; } });",
      extraTree: {},
    },
    {
      label: 'aliased forEach callback',
      rootSource:
        "import { run } from './providers/run.js';\nconst callback = run;\n[db].forEach(callback);",
      extraTree: {},
    },
    {
      label: 'spread callback',
      rootSource: "import { run } from './providers/run.js';\n[db].map(...[run]);",
      extraTree: {},
    },
    {
      label: 'logical callback fallback',
      rootSource: "import { run } from './providers/run.js';\n[db].map(run || fallback);",
      extraTree: {},
    },
    {
      label: 'assigned property callback',
      rootSource:
        "import { run } from './providers/run.js';\nconst holder = {};\nholder.cb = run;\n[db].map(holder.cb);",
      extraTree: {},
    },
    {
      label: 'namespace member callback',
      rootSource: "import * as provider from './providers/run.js';\n[db].map(provider.run);",
      extraTree: {},
    },
    {
      label: 'exported object member callable from an empty provider baseline',
      rootSource: "import { wrapper } from './providers/index.js';\nwrapper.run(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'destructured object member callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst { run } = wrapper;\nrun(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'object member callable assigned to a local alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst execute = wrapper.run;\nexecute(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'object alias member callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst alias = wrapper;\nalias.run(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'assigned object alias member callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nlet alias;\nalias = wrapper;\nalias.run(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'renamed destructured member callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst { run: execute } = wrapper;\nexecute(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'computed string object member callable',
      rootSource: "import { wrapper } from './providers/index.js';\nwrapper['run'](db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'nested object member callable',
      rootSource: "import { wrapper } from './providers/index.js';\nwrapper.nested.run(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { nested: { run } };",
      },
    },
    {
      label: 'dynamic computed object member callable fails closed',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst key = 'run';\nwrapper[key](db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get static member callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nReflect.get(wrapper, 'run')(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get callable through a method alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst get = Reflect.get;\nget(wrapper, 'run')(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get callable through a destructured alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst { get } = Reflect;\nget(wrapper, 'run')(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get callable through an object alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst reflection = Reflect;\nreflection.get(wrapper, 'run')(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get callable through a destructuring assignment',
      rootSource:
        "import { wrapper } from './providers/index.js';\nlet get;\n({ get } = Reflect);\nget(wrapper, 'run')(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get callable through a bound alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst get = Reflect.get.bind(Reflect);\nget(wrapper, 'run')(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get callable through Function.call',
      rootSource:
        "import { wrapper } from './providers/index.js';\nReflect.get.call(Reflect, wrapper, 'run')(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get callable through Function.apply',
      rootSource:
        "import { wrapper } from './providers/index.js';\nReflect.get.apply(Reflect, [wrapper, 'run'])(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get member callable assigned to an alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst execute = Reflect.get(wrapper, 'run');\nexecute(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get member callable through Function.call',
      rootSource:
        "import { wrapper } from './providers/index.js';\nReflect.get(wrapper, 'run').call(undefined, db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get member callable through Reflect.apply',
      rootSource:
        "import { wrapper } from './providers/index.js';\nReflect.apply(Reflect.get(wrapper, 'run'), undefined, [db]);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get unknown member callable fails closed',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst key = process.argv[2];\nReflect.get(wrapper, key)(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'property descriptor value callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nObject.getOwnPropertyDescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect property descriptor value callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nReflect.getOwnPropertyDescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'all property descriptors direct value callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nObject.getOwnPropertyDescriptors(wrapper).run.value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'all property descriptors container alias value callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst all = Object.getOwnPropertyDescriptors(wrapper);\nall.run.value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect descriptor value callable through a method alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst descriptor = Reflect.getOwnPropertyDescriptor;\ndescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'all property descriptors through a bound alias and nested destructuring',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst descriptors = Object.getOwnPropertyDescriptors.bind(Object);\nconst { run: { value } } = descriptors(wrapper);\nvalue(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'all property descriptors unknown member callable fails closed',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst key = process.argv[2];\nObject.getOwnPropertyDescriptors(wrapper)[key].value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect descriptor callable through an object-held method alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst methods = { descriptor: Reflect.getOwnPropertyDescriptor };\nmethods.descriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect descriptor callable through an assigned object method alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst methods = {};\nmethods.descriptor = Reflect.getOwnPropertyDescriptor;\nmethods.descriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'all property descriptors returned by a local factory',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst all = () => Object.getOwnPropertyDescriptors(wrapper);\nall().run.value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'singular Reflect descriptor returned by a parameterized wrapper',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst descriptor = (target, key) => Reflect.getOwnPropertyDescriptor(target, key);\ndescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through a direct variable declaration alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst alias = descriptor;\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through an assignment alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nlet alias; alias = descriptor;\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through an alias chain',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst first = descriptor; const second = first;\nsecond().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through an array declaration alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst [alias] = [descriptor];\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through an array assignment alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nlet alias; [alias] = [descriptor];\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through an object destructuring declaration alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst { factory: alias } = { factory: descriptor };\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through an object assignment alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nlet alias; ({ factory: alias } = { factory: descriptor });\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through an object member',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = { descriptor };\nfactories.descriptor().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable as an assigned object member',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = {}; factories.descriptor = descriptor;\nfactories.descriptor().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory object member callable through a direct alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = { descriptor }; const alias = factories.descriptor;\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable after destructuring an object alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = { descriptor }; const { descriptor: alias } = factories;\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable after destructuring an array alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = [descriptor]; const [alias] = factories;\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable directly through a static class field',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nclass Factories { static descriptor = descriptor; }\nFactories.descriptor().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory object owner alias preserves member binding',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = { descriptor }; const aliases = factories;\naliases.descriptor().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory class owner alias preserves static field binding',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nclass Factories { static descriptor = descriptor; } const Aliases = Factories;\nAliases.descriptor().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through a computed object member',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = { ['descriptor']: descriptor };\nfactories['descriptor']().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable with call',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\ndescriptor.call(null).value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory object member callable with call',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = { descriptor };\nfactories.descriptor.call(null).value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through object rest',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst { ...factories } = { descriptor };\nfactories.descriptor().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through array rest',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst [...factories] = [descriptor];\nfactories[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through nested object members',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = { nested: { descriptor } };\nfactories.nested.descriptor().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through a nested object spread',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = { ...{ descriptor } };\nfactories.descriptor().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through a direct nested array spread',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = [...[descriptor]];\nfactories[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through a variable array spread',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst factories = [descriptor]; const aliases = [...factories]; const [alias] = aliases;\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory array owner alias preserves a spread index binding',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst source = [descriptor]; const factories = source; const aliases = [...factories];\naliases[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory array owner alias preserves a destructured spread binding',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst source = [descriptor]; const factories = source; const aliases = [...factories]; const [alias] = aliases;\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory array owner alias preserves an array rest binding',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst source = [descriptor]; const factories = source; const aliases = [...factories]; const [...rest] = aliases;\nrest[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory array assignment alias preserves a spread binding',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst source = [descriptor]; let factories; factories = source; const aliases = [...factories];\naliases[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory dynamic computed direct call fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const factories = {}; factories[key] = descriptor;\nfactories[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory dynamic computed read alias fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const factories = {}; factories[key] = descriptor; const alias = factories[key];\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory dynamic computed write follows an owner alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const aliases = stores; aliases[key] = descriptor;\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory dynamic computed read follows an owner alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const aliases = stores; stores[key] = descriptor;\naliases[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory dynamic Reflect.set fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; Reflect.set(stores, key, descriptor);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory dynamic Object.assign fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; Object.assign(stores, { [key]: descriptor });\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory dynamic Object.assign follows a source alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const source = { [key]: descriptor }; const stores = {}; Object.assign(stores, source);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory dynamic Object.defineProperty fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; Object.defineProperty(stores, key, { value: descriptor });\nconst alias = stores[key]; alias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory dynamic Reflect.defineProperty fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; Reflect.defineProperty(stores, key, { value: descriptor });\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory dynamic Object.defineProperties fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; Object.defineProperties(stores, { [key]: { value: descriptor } });\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory Object.defineProperty follows a descriptor object alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const prop = { value: descriptor }; Object.defineProperty(stores, key, prop);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory Reflect.defineProperty follows a descriptor object alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const prop = { value: descriptor }; Reflect.defineProperty(stores, key, prop);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperties follows a descriptors map alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const props = { [key]: { value: descriptor } }; Object.defineProperties(stores, props);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory array push fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst arr = []; arr.push(descriptor); arr[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory array unshift fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst arr = []; arr.unshift(descriptor); arr[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperty follows an assigned descriptor object alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; let prop; prop = { value: descriptor }; Object.defineProperty(stores, key, prop);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperty follows a multi-hop descriptor object alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const prop1 = { value: descriptor }; const prop2 = prop1; Object.defineProperty(stores, key, prop2);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory ambiguous descriptor object alias fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; let prop = { value: descriptor }; prop = other; Object.defineProperty(stores, key, prop);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperties follows an assigned descriptors map alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; let props; props = { [key]: { value: descriptor } }; Object.defineProperties(stores, props);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperties follows a multi-hop descriptors map alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const props1 = { [key]: { value: descriptor } }; const props2 = props1; Object.defineProperties(stores, props2);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperties follows a property descriptor alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const prop = { value: descriptor }; const props = { [key]: prop }; Object.defineProperties(stores, props);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory ambiguous descriptors map alias fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; let props = { [key]: { value: descriptor } }; props = other; Object.defineProperties(stores, props);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory array splice insertion fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst arr = []; arr.splice(0, 0, descriptor); arr[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperty merges a value member assignment',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const prop = {}; prop.value = descriptor; Object.defineProperty(stores, key, prop);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperty merges Reflect.set',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const prop = {}; Reflect.set(prop, 'value', descriptor); Object.defineProperty(stores, key, prop);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperty merges Object.assign',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const prop = {}; Object.assign(prop, { value: descriptor }); Object.defineProperty(stores, key, prop);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperties merges a dynamic member assignment',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const props = {}; props[key] = { value: descriptor }; Object.defineProperties(stores, props);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperties merges dynamic Object.assign',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const props = {}; Object.assign(props, { [key]: { value: descriptor } }); Object.defineProperties(stores, props);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory Array prototype unshift call fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst arr = []; Array.prototype.unshift.call(arr, descriptor); arr[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperty merges a computed static value assignment',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const prop = {}; prop['value'] = descriptor; Object.defineProperty(stores, key, prop);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperty dynamic descriptor field fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const field = process.argv[3]; const stores = {}; const prop = {}; prop[field] = descriptor; Object.defineProperty(stores, key, prop);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperty ambiguous value writes fail closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const prop = {}; prop.value = descriptor; prop.value = other; Object.defineProperty(stores, key, prop);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperty merges a get member assignment',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst stores = {}; const prop = {}; prop.get = descriptor; Object.defineProperty(stores, 'fixed', prop);\nstores.fixed().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperty merges a set member assignment',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst stores = {}; const prop = {}; prop.set = descriptor; Object.defineProperty(stores, 'fixed', prop);\nstores.fixed().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperties merges a static member assignment',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst stores = {}; const props = {}; props.fixed = { value: descriptor }; Object.defineProperties(stores, props);\nstores.fixed().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory defineProperty merges an Object.assign source alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst key = process.argv[2]; const stores = {}; const prop = {}; const source = { value: descriptor }; Object.assign(prop, source); Object.defineProperty(stores, key, prop);\nstores[key]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory Array prototype push apply fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst arr = []; Array.prototype.push.apply(arr, [descriptor]); arr[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory Array prototype splice call fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst arr = []; Array.prototype.splice.call(arr, 0, 0, descriptor); arr[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory Array prototype apply follows an argument array alias',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst arr = []; const args = [descriptor]; Array.prototype.unshift.apply(arr, args); arr[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory Array prototype push apply expands a direct array spread',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst arr = []; Array.prototype.push.apply(arr, [...[descriptor]]); arr[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory Array prototype unshift apply expands an argument alias spread',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst arr = []; const args = [descriptor]; Array.prototype.unshift.apply(arr, [...args]); arr[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory Array prototype splice apply expands nested multi-element spreads',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst arr = []; const prefix = [0, 0]; const values = [descriptor]; Array.prototype.splice.apply(arr, [...prefix, 'safe', ...[...values]]); arr[1]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory Array prototype push apply fails closed for a dynamic spread',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst arr = []; const args = process.argv[2] ? [descriptor] : []; Array.prototype.push.apply(arr, [...args]); arr[0]().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through a single static factory return',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nfunction select() { return descriptor; } const alias = select();\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory callable through chained static factory returns',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nfunction select1() { return descriptor; } function select2() { return select1; }\nselect2()()().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory return callable through a declaration alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nfunction select() { return descriptor; } const choose = select;\nchoose()().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory return callable through an assignment alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nfunction select() { return descriptor; } let choose; choose = select;\nchoose()().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory return callable through a multi-hop alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nfunction select() { return descriptor; } const choose1 = select; const choose2 = choose1;\nchoose2()().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory forwarded as an unproven callback fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nfunction invoke(callback) { return callback(); }\ninvoke(descriptor).value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory conditional alias fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nconst alias = useOther ? other : descriptor;\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'descriptor factory alias with multiple writes fails closed',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor() { return Reflect.getOwnPropertyDescriptor(wrapper, 'run'); }\nlet alias = descriptor; alias = other;\nalias().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'singular Reflect descriptor returned through a block alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor(target, key) { const result = Reflect.getOwnPropertyDescriptor(target, key); return result; }\ndescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'singular descriptor wrapper resolves block-local parameter aliases',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor(target, key) { const owner = target, name = key; const result = Reflect.getOwnPropertyDescriptor(owner, name); return result; }\ndescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'singular descriptor wrapper resolves aliases from a nested block',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor(target, key) { let result; { const first = target, owner = first, name = key; result = Reflect.getOwnPropertyDescriptor(owner, name); } return result; }\ndescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'singular descriptor wrapper fails closed for an ambiguous local target',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor(target, key) { let owner = target; if (useOther) owner = other; return Reflect.getOwnPropertyDescriptor(owner, key); }\ndescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'singular descriptor wrapper fails closed when a parameter is reassigned',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor(target, key) { target = wrapper; return Reflect.getOwnPropertyDescriptor(target, key); }\ndescriptor(other, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'singular descriptor wrapper fails closed for logical parameter assignment',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor(target, key) { target ||= wrapper; return Reflect.getOwnPropertyDescriptor(target, key); }\ndescriptor(undefined, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'singular descriptor wrapper fails closed for destructuring parameter assignment',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor(target, key) { ({ target } = { target: wrapper }); return Reflect.getOwnPropertyDescriptor(target, key); }\ndescriptor(other, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'singular descriptor wrapper fails closed for default and destructured parameters',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptor({ target } = { target: wrapper }, key = 'run') { return Reflect.getOwnPropertyDescriptor(target, key); }\ndescriptor().value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'plural descriptors returned through a block alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptors(target) { const result = Object.getOwnPropertyDescriptors(target); return result; }\ndescriptors(wrapper).run.value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'plural descriptor wrapper resolves a block-local parameter alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptors(target) { const owner = target; const result = Object.getOwnPropertyDescriptors(owner); return result; }\ndescriptors(wrapper).run.value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'plural descriptor wrapper resolves aliases from a nested block',
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptors(target) { let result; { const first = target, owner = first; result = Object.getOwnPropertyDescriptors(owner); } return result; }\ndescriptors(wrapper).run.value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'plural descriptor wrapper fails closed for ambiguous return branches and targets',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptors(target) { if (useOther) return Object.getOwnPropertyDescriptors(other); return Object.getOwnPropertyDescriptors(target); }\ndescriptors(wrapper).run.value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'plural descriptor wrapper fails closed for parameter member expressions',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptors(options) { return Object.getOwnPropertyDescriptors(options.target); }\ndescriptors({ target: wrapper }).run.value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'plural descriptor wrapper fails closed for nullish parameter assignment',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptors(target) { target ??= wrapper; return Object.getOwnPropertyDescriptors(target); }\ndescriptors(undefined).run.value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'plural descriptor wrapper fails closed for array parameter assignment',
      closureOnly: true,
      rootSource:
        "import { wrapper } from './providers/index.js';\nfunction descriptors(target) { [target] = [wrapper]; return Object.getOwnPropertyDescriptors(target); }\ndescriptors(other).run.value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect descriptor callable through Function.prototype.call.bind',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst descriptor = Function.prototype.call.bind(Reflect.getOwnPropertyDescriptor, Reflect);\ndescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'Reflect.get reads a callable descriptor value',
      rootSource:
        "import { wrapper } from './providers/index.js';\nReflect.get(Object.getOwnPropertyDescriptor(wrapper, 'run'), 'value')(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'property descriptor value callable through a method alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst descriptor = Object.getOwnPropertyDescriptor;\ndescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'property descriptor value callable through a destructured alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst { getOwnPropertyDescriptor: descriptor } = Object;\ndescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'property descriptor value callable through a destructuring assignment',
      rootSource:
        "import { wrapper } from './providers/index.js';\nlet descriptor;\n({ getOwnPropertyDescriptor: descriptor } = Object);\ndescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'property descriptor value callable through a bound alias',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst descriptor = Object.getOwnPropertyDescriptor.bind(Object);\ndescriptor(wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'property descriptor value callable through Function.call',
      rootSource:
        "import { wrapper } from './providers/index.js';\nObject.getOwnPropertyDescriptor.call(Object, wrapper, 'run').value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'property descriptor value callable through Function.apply',
      rootSource:
        "import { wrapper } from './providers/index.js';\nObject.getOwnPropertyDescriptor.apply(Object, [wrapper, 'run']).value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'property descriptor value callable through Function.apply',
      rootSource:
        "import { wrapper } from './providers/index.js';\nObject.getOwnPropertyDescriptor(wrapper, 'run').value.apply(undefined, [db]);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'property descriptor alias value callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst descriptor = Object.getOwnPropertyDescriptor(wrapper, 'run');\ndescriptor.value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'property descriptor unknown value callable fails closed',
      rootSource:
        "import { wrapper } from './providers/index.js';\nObject.getOwnPropertyDescriptor(wrapper, process.argv[2]).value(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'nested renamed destructured member callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nconst { nested: { run: execute } } = wrapper;\nexecute(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { nested: { run } };",
      },
    },
    {
      label: 'destructuring assignment member callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nlet execute;\n({ run: execute } = wrapper);\nexecute(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'logical assignment member callable',
      rootSource:
        "import { wrapper } from './providers/index.js';\nlet execute;\nexecute ||= wrapper.run;\nexecute(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      },
    },
    {
      label: 'object member callable through an alias and re-export',
      rootSource: "import { migrated } from './providers/index.js';\nmigrated.run(db);",
      extraTree: {
        [barrel]: "export { wrapper as migrated } from './wrapper.js';",
        'server/src/data/governance-schema/providers/wrapper.ts':
          "import { run } from './run.js';\nconst base = { run };\nexport const wrapper = base;",
      },
    },
    {
      label: 'object member callable returned by a factory',
      rootSource: "import { wrapper } from './providers/index.js';\nwrapper.run(db);",
      extraTree: {
        [barrel]:
          "import { run } from './run.js';\nconst makeWrapper = (callback) => ({ run: callback });\nexport const wrapper = makeWrapper(run);",
      },
    },
    {
      label: 'object member callable returned by a named zero-argument factory',
      rootSource: "import { wrapper } from './providers/index.js';\nwrapper.run(db);",
      extraTree: {
        [barrel]:
          "import { run } from './run.js';\nfunction makeWrapper() { return { run }; }\nexport const wrapper = makeWrapper();",
      },
    },
    {
      label: 'object member callable through a namespace spread',
      rootSource: "import { wrapper } from './providers/index.js';\nwrapper.run(db);",
      extraTree: {
        [barrel]: "import * as danger from './run.js';\nexport const wrapper = { ...danger };",
      },
    },
    {
      label: 'default-exported object member callable',
      rootSource: "import wrapper from './providers/index.js';\nwrapper.run(db);",
      extraTree: {
        [barrel]: "import { run } from './run.js';\nexport default { run };",
      },
    },
    {
      label: 'barrel Promise callback',
      rootSource:
        "import { runMigration } from './providers/index.js';\nPromise.resolve(db).then(runMigration);",
      extraTree: { [barrel]: "export { run as runMigration } from './run.js';" },
    },
  ]) {
    const baselines = {
      [root]: callbackCase.rootSource,
      [provider]: baselineProvider,
      ...callbackCase.extraTree,
    };
    const targets = {
      [root]: callbackCase.rootSource,
      [provider]: targetProvider,
      ...callbackCase.extraTree,
    };
    const result = plan(targetProvider, addedSourceDiff("await db.query('DROP TABLE users');"), {
      changedPaths: [provider],
      baselines,
      targets,
      diffs: { [provider]: addedSourceDiff("await db.query('DROP TABLE users');") },
      nameStatus: `M\t${provider}`,
    });
    assert.equal(result.ok, false, callbackCase.label);
    assert.match(
      result.blockingReasons.join('\n'),
      callbackCase.closureOnly ? /dependency closure could not be proven/u : /run\.ts/u,
      callbackCase.label,
    );
  }
});

test('fails closed when reflective apply arguments are dynamic', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const provider = 'server/src/data/governance-schema/providers/run.ts';
  const rootSource =
    "import { wrapper } from './providers/index.js';\nReflect.get.apply(Reflect, reflectiveArgs)(db);";
  const providerSource = "export async function run(db) { await db.query('DROP TABLE users'); }";
  const barrel = 'server/src/data/governance-schema/providers/index.ts';
  const result = plan(providerSource, addedSourceDiff("await db.query('DROP TABLE users');"), {
    changedPaths: [provider],
    baselines: {
      [root]: rootSource,
      [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      [provider]: 'export async function run(_db) {}',
    },
    targets: {
      [root]: rootSource,
      [barrel]: "import { run } from './run.js';\nexport const wrapper = { run };",
      [provider]: providerSource,
    },
    diffs: { [provider]: addedSourceDiff("await db.query('DROP TABLE users');") },
    nameStatus: `M\t${provider}`,
  });
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /dependency closure could not be proven/u);
});

test('tracks constructable class providers and their instance methods', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const provider = 'server/src/data/governance-schema/providers/runner.ts';
  const rootSource = "import { Runner } from './providers/runner.js';\nnew Runner(db).run();";
  const baselineProvider = 'export class Runner { run() {} }';
  const targetProvider = "export class Runner { run() { db.query('DROP TABLE users'); } }";
  const result = plan(targetProvider, addedSourceDiff("db.query('DROP TABLE users');"), {
    changedPaths: [provider],
    baselines: { [root]: rootSource, [provider]: baselineProvider },
    targets: { [root]: rootSource, [provider]: targetProvider },
    diffs: { [provider]: addedSourceDiff("db.query('DROP TABLE users');") },
    nameStatus: `M\t${provider}`,
  });
  assert.equal(result.ok, false);
  assert.match(result.blockingReasons.join('\n'), /runner\.ts/u);
});

test('does not treat direct data or side-effect-free reflective reads as callable providers', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const provider = 'server/src/data/governance-schema/provider.ts';
  const baselineProvider =
    "export const config = { name: 'safe' };\nexport async function run(db) { await db.query('CREATE TABLE users(id text)'); }";
  const targetProvider =
    "export const config = { name: 'safe' };\nexport async function run(db) { await db.query('DROP TABLE users'); }";
  for (const rootSource of [
    "import * as provider from './provider.js';\nregistry.map(provider.config);",
    "import * as provider from './provider.js';\nReflect.get(provider, 'config');",
    "import * as provider from './provider.js';\nObject.getOwnPropertyDescriptor(provider, 'config');",
    "import * as provider from './provider.js';\nReflect.getOwnPropertyDescriptor(provider, 'config');",
    "import * as provider from './provider.js';\nObject.getOwnPropertyDescriptors(provider).config;",
    "import * as provider from './provider.js';\nconst descriptors = Object.getOwnPropertyDescriptors;\ndescriptors(provider).config;",
    "import * as provider from './provider.js';\nconst descriptor = Object.getOwnPropertyDescriptor;\ndescriptor(provider, 'config');",
    "import * as provider from './provider.js';\nconst get = Reflect.get.bind(Reflect);\nget(provider, 'config');",
    "import * as provider from './provider.js';\nconst descriptor = Object.getOwnPropertyDescriptor.bind(Object);\ndescriptor(provider, 'config');",
    "import * as provider from './provider.js';\nconst methods = { descriptor: Object.getOwnPropertyDescriptor };\nmethods.descriptor(provider, 'config');",
  ]) {
    const result = plan(targetProvider, addedSourceDiff("await db.query('DROP TABLE users');"), {
      changedPaths: [provider],
      baselines: { [root]: rootSource, [provider]: baselineProvider },
      targets: { [root]: rootSource, [provider]: targetProvider },
      diffs: { [provider]: addedSourceDiff("await db.query('DROP TABLE users');") },
      nameStatus: `M\t${provider}`,
    });
    assert.equal(result.ok, true, rootSource);
    assert.equal(result.migrationPlan.phase, 'none', rootSource);
  }
});

// Dynamic module resolution is independent of the static callable/member closure above.
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
  const dangerSource =
    "await import('../../utils/logger.js');\nawait db.query('DROP TABLE users');\nexport type T = string;";
  for (const rootSource of [
    "import type { T } from './danger.js';\nexport type { T };",
    "import { type T } from './danger.js';\nexport type { T };",
    "export type { T } from './danger.js';",
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

test('skips type-only import-equals while preserving runtime import-equals callable edges', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const danger = 'server/src/data/governance-schema/danger.ts';
  const baselineDanger =
    "export type T = string;\nexport async function run(db) { await db.query('CREATE TABLE users(id text)'); }";
  const targetDanger =
    "export type T = string;\nexport async function run(db) { await db.query('DROP TABLE users'); }";

  const typeOnlyRoot =
    "import type Danger = require('./danger.js');\nexport type Alias = Danger.T;";
  const typeOnly = plan(targetDanger, addedSourceDiff("await db.query('DROP TABLE users');"), {
    changedPaths: [danger],
    baselines: { [root]: typeOnlyRoot, [danger]: baselineDanger },
    targets: { [root]: typeOnlyRoot, [danger]: targetDanger },
    diffs: { [danger]: addedSourceDiff("await db.query('DROP TABLE users');") },
    nameStatus: `M\t${danger}`,
  });
  assert.equal(typeOnly.ok, true);
  assert.equal(typeOnly.migrationPlan.phase, 'none');

  const runtimeRoot =
    "import Danger = require('./danger.js');\nexport async function migrate(db) { await Danger.run(db); }";
  const runtime = plan(targetDanger, addedSourceDiff("await db.query('DROP TABLE users');"), {
    changedPaths: [danger],
    baselines: { [root]: runtimeRoot, [danger]: baselineDanger },
    targets: { [root]: runtimeRoot, [danger]: targetDanger },
    diffs: { [danger]: addedSourceDiff("await db.query('DROP TABLE users');") },
    nameStatus: `M\t${danger}`,
  });
  assert.equal(runtime.ok, false);
  assert.match(runtime.blockingReasons.join('\n'), /danger\.ts/u);
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
    'CREATE INDEX safe_hash_idx ON safe_addition USING hash (id);',
    'CREATE INDEX safe_include_idx ON safe_addition(id DESC NULLS LAST) INCLUDE (note);',
    'CREATE INDEX safe_lower_idx ON safe_addition(pg_catalog.lower(note));',
    'CREATE TABLE safe_primary(id text PRIMARY KEY);',
    'CREATE SEQUENCE IF NOT EXISTS safe_sequence;',
    'CREATE TABLE safe_identity(id bigint GENERATED ALWAYS AS IDENTITY);',
    'CREATE TABLE safe_types(amount numeric(10, 2), label varchar(255), created_at timestamp(6));',
    'CREATE TABLE safe_generated(first text, lowered text GENERATED ALWAYS AS (pg_catalog.lower(first)) STORED);',
    'ALTER TABLE safe_addition ADD COLUMN note numeric(10, 2);',
    'ALTER TABLE safe_addition ADD COLUMN nullable_note text;',
    'ALTER TABLE safe_addition ADD COLUMN builtin_note pg_catalog.text;',
    "ALTER TABLE safe_addition ADD COLUMN escaped text DEFAULT E'foo\\\',bar; -- DROP';",
    "ALTER TABLE safe_addition ADD COLUMN quoted text DEFAULT 'DROP, SELECT;';",
    'ALTER TABLE safe_addition ADD COLUMN dollar text DEFAULT $$DROP, SELECT;$$;',
    'ALTER /* outer /* nested DROP, SELECT; */ comment */ TABLE safe_addition ADD COLUMN nested text;',
    'ALTER TABLE safe_addition VALIDATE CONSTRAINT safe_check;',
  ]) {
    const validSource = sqlSource(valid);
    const validResult = plan(validSource, addedSourceDiff(validSource));
    assert.equal(validResult.ok, true, valid);
  }
});

test('rejects unknown and context-confused function calls inside allowed CREATE statements', () => {
  for (const statement of [
    'CREATE INDEX unsafe_idx ON users (custom_migration(id));',
    'CREATE INDEX unsafe_idx ON users ((id !@! id));',
    'CREATE INDEX unsafe_idx ON users ((id)::evil_type);',
    'CREATE INDEX unsafe_idx ON users USING btree (id evil_ops);',
    'CREATE INDEX unsafe_idx ON users (id) WHERE id !@! id;',
    'CREATE INDEX unsafe_idx ON users USING evil_access_method (id);',
    'CREATE INDEX unsafe_idx ON users (hash(id));',
    'CREATE INDEX unsafe_idx ON users (include(id));',
    'CREATE INDEX unsafe_idx ON users (key(id));',
    'CREATE INDEX unsafe_idx ON users (range(id));',
    'CREATE INDEX unsafe_idx ON users (exclude(id));',
    'CREATE INDEX unsafe_idx ON users (numeric(id));',
    'CREATE INDEX unsafe_idx ON users (varchar(id));',
    'CREATE INDEX unsafe_idx ON users (timestamp(id));',
    'CREATE TABLE unsafe_default(id integer DEFAULT numeric(1));',
    'CREATE TABLE unsafe_literal_default(id integer DEFAULT 1);',
    'CREATE TABLE unsafe_literal_check(id integer CHECK (id > 0));',
    'ALTER TABLE records ADD CONSTRAINT records_pkey PRIMARY KEY (id);',
    'ALTER TABLE records ADD CONSTRAINT records_email_key UNIQUE (email);',
    'ALTER TABLE records ADD CONSTRAINT records_owner_fkey FOREIGN KEY (owner_id) REFERENCES users(id);',
    'ALTER TABLE records ADD CONSTRAINT records_excl EXCLUDE USING gist (period WITH &&);',
    'ALTER TABLE records ADD CONSTRAINT unsafe_operator CHECK (id !@! 1);',
    'ALTER TABLE records ADD CONSTRAINT owner_required CHECK (owner_id IS NOT NULL);',
    "ALTER TABLE records ADD CONSTRAINT non_empty CHECK (owner_id <> '');",
    'ALTER TABLE records ADD CONSTRAINT positive CHECK ((id > 0)) NOT VALID;',
    'ALTER TABLE records ADD CHECK (owner_id IS NOT NULL);',
    'ALTER TABLE records ADD PRIMARY KEY (id);',
    'ALTER TABLE records ADD UNIQUE (email);',
    'ALTER TABLE records ADD FOREIGN KEY (owner_id) REFERENCES users(id);',
    'ALTER TABLE records ADD EXCLUDE USING gist (period WITH &&);',
    'ALTER TABLE records ADD CHECK (id !@! 1);',
    'ALTER TABLE records ADD CONSTRAINT future_syntax;',
    'ALTER TABLE records ADD IF NOT EXISTS CONSTRAINT owner_required CHECK (owner_id IS NOT NULL);',
    'ALTER TABLE records ADD NOT NULL owner_id;',
    'CREATE TABLE unsafe_partition(id integer) PARTITION BY RANGE (id);',
    "CREATE TABLE unsafe_check(id integer CHECK (varchar(id) <> ''));",
    'CREATE INDEX unsafe_idx ON users (evil.lower(name));',
    'CREATE INDEX unsafe_idx ON users (evil.pg_catalog.lower(name));',
    'CREATE INDEX unsafe_idx ON users ("evil".pg_catalog.lower(name));',
    'CREATE INDEX unsafe_idx ON users (lower(name));',
    'CREATE INDEX unsafe_idx ON users (pg_catalog."lower"(name));',
    'CREATE INDEX unsafe_idx ON users ("pg_catalog".lower(name));',
    'CREATE TABLE unsafe_default(id bigint DEFAULT custom_migration());',
    'CREATE TABLE unsafe_generated(id text, derived text GENERATED ALWAYS AS (custom_migration(id)) STORED);',
  ]) {
    const source = sqlSource(statement);
    const result = plan(source, addedSourceDiff(source));
    assert.equal(result.ok, false, statement);
    assert.match(result.blockingReasons.join('\n'), /contract or non-whitelisted/u);
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
  'ALTER TABLE records ADD COLUMN email text UNIQUE;',
  'ALTER TABLE records ADD COLUMN id text PRIMARY KEY;',
  'ALTER TABLE records ADD COLUMN owner_id uuid REFERENCES users(id);',
  'ALTER TABLE records ADD COLUMN score integer CHECK (score > 0);',
  'ALTER TABLE records ADD COLUMN score integer CONSTRAINT positive CHECK (score > 0);',
  "ALTER TABLE records ADD COLUMN x bigint DEFAULT nextval('shared_seq');",
  'ALTER TABLE records ADD COLUMN period tstzrange EXCLUDE USING gist (period WITH &&);',
  'ALTER TABLE records ADD COLUMN id serial;',
  'ALTER TABLE records ADD COLUMN id serial2;',
  'ALTER TABLE records ADD COLUMN id serial4;',
  'ALTER TABLE records ADD COLUMN id serial8;',
  'ALTER TABLE records ADD COLUMN owner public.required_text;',
  'ALTER TABLE records ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY;',
  'ALTER TABLE records ADD COLUMN derived integer GENERATED ALWAYS AS (public.expensive_immutable(id)) STORED;',
  'ALTER TABLE records ADD COLUMN x integer DEFAULT (1 !@! 1);',
  'ALTER TABLE records ADD COLUMN x integer DEFAULT -1;',
  'ALTER TABLE records ADD COLUMN x integer DEFAULT +1;',
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

test('real repository closure ignores unrelated TypeScript changes behind type-only edges', () => {
  const event = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : undefined;
  const target = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const eventBaseline = event?.pull_request?.base?.sha ?? event?.before;
  let baseline = eventBaseline;
  if (baseline) {
    try {
      execFileSync('git', ['cat-file', '-e', `${baseline}^{commit}`], { stdio: 'ignore' });
    } catch {
      // GitHub PR checkout is shallow; the target tree still exercises the real runtime closure.
      baseline = target;
    }
  } else {
    baseline = execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim();
  }
  const result = createMigrationPlan({
    changedPaths: ['server/src/release/releaseAttestation.ts'],
    baseline,
    target,
  });
  assert.equal(result.ok, true, result.blockingReasons.join('\n'));
  assert.equal(result.migrationPlan.phase, 'none');
});

test('classifies destructive SQL when only a statically imported JSON resource changes', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const provider = 'server/src/data/governance-schema/provider.json';
  const rootSource =
    "import statements from './provider.json' with { type: 'json' };\nexport { statements };";
  const baselineProvider = '["CREATE TABLE IF NOT EXISTS safe(id text)"]';
  const targetProvider = '["DROP TABLE users"]';
  const result = plan(targetProvider, addedSourceDiff(targetProvider), {
    changedPaths: [provider],
    baselines: { [root]: rootSource, [provider]: baselineProvider },
    targets: { [root]: rootSource, [provider]: targetProvider },
    diffs: { [provider]: addedSourceDiff(targetProvider) },
    nameStatus: `M\t${provider}`,
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.migrationPlan.phase, 'none');
  assert.match(result.blockingReasons.join('\n'), /contract or non-whitelisted/u);
});

test('classifies static node:fs resource reads and rejects dynamic resource paths', () => {
  const root = 'server/src/data/governance-schema/migrations.ts';
  const provider = 'server/src/data/governance-schema/provider.json';
  const providerSource = '["DROP TABLE users"]';
  const staticRoot =
    "import { readFileSync } from 'node:fs';\nexport const statements = JSON.parse(readFileSync(new URL('./provider.json', import.meta.url), 'utf8'));";
  const result = plan(providerSource, addedSourceDiff(providerSource), {
    changedPaths: [provider],
    baselines: { [root]: staticRoot, [provider]: '["SELECT 1"]' },
    targets: { [root]: staticRoot, [provider]: providerSource },
    diffs: { [provider]: addedSourceDiff(providerSource) },
    nameStatus: `M\t${provider}`,
  });
  assert.equal(result.ok, false);
  assert.notEqual(result.migrationPlan.phase, 'none');

  const dynamicRoot =
    "import { readFileSync } from 'node:fs';\nexport const statements = JSON.parse(readFileSync(process.env.PROVIDER_PATH, 'utf8'));";
  const dynamic = plan(providerSource, addedSourceDiff(providerSource), {
    changedPaths: [provider],
    baselines: { [root]: dynamicRoot, [provider]: '["SELECT 1"]' },
    targets: { [root]: dynamicRoot, [provider]: providerSource },
    diffs: { [provider]: addedSourceDiff(providerSource) },
    nameStatus: `M\t${provider}`,
  });
  assert.equal(dynamic.ok, false);
  assert.match(dynamic.blockingReasons.join('\n'), /dynamic resource paths fail closed/u);
});
