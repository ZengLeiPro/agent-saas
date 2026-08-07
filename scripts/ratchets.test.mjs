import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  THRESHOLDS,
  collectOverThreshold,
  countLines,
  evaluateMaxLines,
  formatBaseline,
  isGovernedSourcePath,
  parseBaseline,
} from './check-max-lines-ratchet.mjs';
import {
  DOMAINS,
  collectEnvNames,
  evaluateEnv,
  isCountedPath,
  scanSource,
  snapshotEnv,
} from './check-env-var-count.mjs';
import {
  DEFAULT_CEILINGS,
  DEFAULT_TOLERANCE,
  METRIC_KEYS,
  collectMetrics,
  evaluateWeb,
  runWebBudget,
  startupAssets,
} from './check-web-startup-budget.mjs';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, file, content) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function initRepo() {
  const root = tempDir('ratchet-git-');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'ratchet@example.invalid');
  git(root, 'config', 'user.name', 'Ratchet Test');
  write(root, 'README.md', 'fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return root;
}

function webBaseline(metrics, overrides = {}) {
  return {
    schemaVersion: 1,
    metrics: { ...metrics },
    tolerance: DEFAULT_TOLERANCE,
    ceilings: DEFAULT_CEILINGS,
    reason: 'measured fixture',
    updatedAt: '2026-08-05',
    ...overrides,
  };
}

function envBaseline(collection) {
  return snapshotEnv(collection, 'measured fixture');
}

test('max-lines counts CRLF physical lines and uses distribution-derived production/test thresholds', () => {
  assert.equal(countLines('a\r\nb\r\n'), 2);
  assert.equal(countLines('a\rb'), 2);
  assert.equal(countLines(''), 0);
  assert.deepEqual(THRESHOLDS, { production: 1000, test: 800 });
  const parsed = parseBaseline('server/src/a.ts\t1001\tproduction\nserver/src/a.test.ts 801 test\n');
  assert.match(formatBaseline(parsed), /a\.test\.ts\t801\ttest/u);
});

test('max-lines narrowly excludes generated/build output but governs maintained source', () => {
  assert.equal(isGovernedSourcePath('server/src/app.ts'), true);
  assert.equal(isGovernedSourcePath('server/src/generated/client.ts'), false);
  assert.equal(isGovernedSourcePath('server/dist/app.js'), false);
  assert.equal(isGovernedSourcePath('docs/example.ts'), false);
});

test('max-lines blocks a new over-limit file and grandfather growth, and requires prune after a decrease', () => {
  const current = new Map([['server/src/new.ts', { lines: 1001, scope: 'production' }]]);
  assert.match(evaluateMaxLines({ current, baseline: new Map(), baseBaseline: null, renames: new Map() }).errors.join('\n'), /NEW over-threshold/u);

  const baseline = new Map([['server/src/old.ts', { lines: 1200, scope: 'production' }]]);
  const grown = new Map([['server/src/old.ts', { lines: 1201, scope: 'production' }]]);
  assert.match(evaluateMaxLines({ current: grown, baseline, baseBaseline: baseline, renames: new Map() }).errors.join('\n'), /GROWN/u);

  const lower = new Map([['server/src/old.ts', { lines: 1100, scope: 'production' }]]);
  assert.match(evaluateMaxLines({ current: lower, baseline, baseBaseline: baseline, renames: new Map() }).errors.join('\n'), /LOWERED/u);
  assert.equal(evaluateMaxLines({ current: lower, baseline, baseBaseline: baseline, renames: new Map(), prune: true }).errors.length, 0);
});

test('max-lines reports stale entries, preserves renamed debt identity, and blocks merge-base expansion', () => {
  const baseline = new Map([['server/src/old.ts', { lines: 1200, scope: 'production' }]]);
  assert.match(evaluateMaxLines({ current: new Map(), baseline, baseBaseline: baseline, renames: new Map() }).errors.join('\n'), /STALE/u);

  const renamed = new Map([['server/src/new.ts', { lines: 1200, scope: 'production' }]]);
  assert.equal(evaluateMaxLines({ current: renamed, baseline, baseBaseline: baseline, renames: new Map([['server/src/new.ts', 'server/src/old.ts']]) }).errors.length, 0);

  const expanded = new Map([['server/src/old.ts', { lines: 1250, scope: 'production' }]]);
  assert.match(evaluateMaxLines({ current: renamed, baseline: expanded, baseBaseline: baseline, renames: new Map([['server/src/new.ts', 'server/src/old.ts']]) }).errors.join('\n'), /BASELINE EXPANDED/u);
});

test('max-lines working-tree and staged snapshots are distinct and reliable', () => {
  const root = initRepo();
  try {
    write(root, 'server/src/large.ts', 'x\n'.repeat(1001));
    assert.equal(collectOverThreshold(root).has('server/src/large.ts'), true);
    assert.equal(collectOverThreshold(root, { staged: true }).has('server/src/large.ts'), false);
    git(root, 'add', 'server/src/large.ts');
    assert.equal(collectOverThreshold(root, { staged: true }).get('server/src/large.ts').lines, 1001);
    write(root, 'server/src/large.ts', 'x\n');
    assert.equal(collectOverThreshold(root).has('server/src/large.ts'), false);
    assert.equal(collectOverThreshold(root, { staged: true }).has('server/src/large.ts'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('env scanner handles dot/bracket/import.meta/helper/centralized names, dedupes, and reports dynamics without values', () => {
  const result = scanSource(`
    process.env.FOO; process.env['BAR']; process.env.FOO;
    import.meta.env.VITE_API; requireEnv("BAZ");
    const ENV_NAMES = ['CENTRAL', 'FOO'];
    process.env[prefix + name]; requireEnv(variableName);
  `);
  assert.deepEqual([...result.names].sort(), ['BAR', 'BAZ', 'CENTRAL', 'FOO', 'VITE_API']);
  assert.deepEqual(result.dynamic.sort(), ['prefix + name', 'variableName']);
  assert.equal(Object.values(process.env).some((value) => result.names.has(value)), false);
});

test('env path policy excludes tests/generated and assigns production/script domains', () => {
  assert.equal(isCountedPath('server/src/index.ts'), true);
  assert.equal(isCountedPath('server/src/index.test.ts'), false);
  assert.equal(isCountedPath('web/src/generated/env.ts'), false);
  assert.equal(isCountedPath('server/scripts/migrate.mts'), true);
});

test('env collection uses distinct names per runtime domain and excludes test variables', () => {
  const root = initRepo();
  try {
    write(root, 'server/src/app.ts', 'process.env.SERVER_A; process.env.SERVER_A;');
    write(root, 'web/src/app.ts', 'import.meta.env.VITE_A;');
    write(root, 'server/src/app.test.ts', 'process.env.TEST_ONLY;');
    write(root, 'scripts/deploy.mjs', 'requireEnv("DEPLOY_A");');
    const result = collectEnvNames(root);
    assert.deepEqual([...result.domains.server], ['SERVER_A']);
    assert.deepEqual([...result.domains['web build-time']], ['VITE_A']);
    assert.deepEqual([...result.domains['deployment/scripts']], ['DEPLOY_A']);
    assert.equal([...result.domains.server].includes('TEST_ONLY'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('env ratchet blocks additions, requires stale deletion prune, and rejects baseline growth vs merge-base', () => {
  const empty = { domains: Object.fromEntries(DOMAINS.map((domain) => [domain, new Set()])), dynamic: [] };
  const baseline = envBaseline(empty);
  const added = { domains: Object.fromEntries(DOMAINS.map((domain) => [domain, new Set()])), dynamic: [] };
  added.domains.server.add('NEW_NAME');
  assert.match(evaluateEnv({ collection: added, baseline }).errors.join('\n'), /added: NEW_NAME/u);

  const withOld = structuredClone(baseline);
  withOld.domains.server = { budget: 1, names: ['OLD_NAME'] };
  assert.match(evaluateEnv({ collection: empty, baseline: withOld }).errors.join('\n'), /stale: OLD_NAME/u);
  assert.equal(evaluateEnv({ collection: empty, baseline: withOld, prune: true }).errors.length, 0);

  assert.match(evaluateEnv({ collection: empty, baseline: withOld, baseBaseline: baseline, prune: true }).errors.join('\n'), /budget expanded|baseline added/u);
});

test('web startup entry parsing ignores lazy chunks and handles attribute order/query strings', () => {
  const assets = startupAssets(`
    <link href="/assets/main.css?v=1" media="all" rel="stylesheet">
    <script type="module" src="./assets/main.js?v=1"></script>
    <link rel="modulepreload" href="/assets/lazy.js">
    <!-- /assets/not-startup.js -->
  `);
  assert.deepEqual(assets, { js: ['assets/main.js'], css: ['assets/main.css'] });
});

test('web metrics count requests, gzip/brotli totals and largest startup chunks only', () => {
  const dist = tempDir('web-budget-');
  try {
    write(dist, 'index.html', '<script src="/assets/a.js"></script><script src="/assets/b.js"></script><link rel="stylesheet" href="/assets/a.css">');
    write(dist, 'assets/a.js', 'a'.repeat(4000));
    write(dist, 'assets/b.js', 'b'.repeat(1000));
    write(dist, 'assets/a.css', 'body{}'.repeat(300));
    write(dist, 'assets/lazy.js', 'lazy'.repeat(100000));
    const metrics = collectMetrics(dist);
    assert.equal(metrics.startupJsRequests, 2);
    assert.equal(metrics.startupCssRequests, 1);
    assert.ok(metrics.startupJsGzipBytes > 0 && metrics.startupJsBrotliBytes > 0);
    assert.ok(metrics.largestJsGzipBytes > 0 && metrics.largestJsBrotliBytes > 0);
    assert.equal(metrics.largestJs, 'assets/a.js');
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('web evaluation enforces request/byte tolerance, absolute ceilings, lowering hints and reasoned baseline growth', () => {
  const metrics = Object.fromEntries(METRIC_KEYS.map((key) => [key, key.endsWith('Requests') ? 1 : 1000]));
  const baseline = webBaseline(metrics);
  assert.equal(evaluateWeb({ ...metrics, startupJsGzipBytes: 2024 }, baseline).errors.length, 0);
  assert.match(evaluateWeb({ ...metrics, startupJsGzipBytes: 2025 }, baseline).errors.join('\n'), /baseline/u);
  assert.match(evaluateWeb({ ...metrics, startupJsRequests: 21 }, baseline).errors.join('\n'), /absolute ceiling/u);
  assert.ok(evaluateWeb({ ...metrics, startupJsRequests: 0 }, baseline).lowered.includes('startupJsRequests: 1 -> 0'));

  const grown = webBaseline({ ...metrics, startupJsGzipBytes: 3000 });
  assert.match(evaluateWeb(metrics, grown, baseline).errors.join('\n'), /without a new explicit reason/u);
  assert.equal(evaluateWeb(metrics, { ...grown, reason: 'reviewed necessary growth' }, baseline).errors.length, 0);
});

test('web baseline update requires an explicit reason and never performs a build', () => {
  const root = tempDir('web-update-');
  try {
    write(root, 'dist/index.html', '<script src="/a.js"></script><link rel="stylesheet" href="/a.css">');
    write(root, 'dist/a.js', 'console.log(1)');
    write(root, 'dist/a.css', 'body{}');
    const metrics = collectMetrics(path.join(root, 'dist'));
    write(root, 'baseline.json', `${JSON.stringify(webBaseline(metrics), null, 2)}\n`);
    assert.throws(() => runWebBudget(root, ['--dist', 'dist', '--baseline', 'baseline.json', '--update-baseline']), /requires --reason/u);
    const result = runWebBudget(root, ['--dist', 'dist', '--baseline', 'baseline.json', '--update-baseline', '--reason', 'measured production fixture']);
    assert.match(result.message, /explicit reason/u);
    assert.equal(fs.existsSync(path.join(root, 'web/dist')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
