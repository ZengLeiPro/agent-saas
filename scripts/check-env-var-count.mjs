#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isTestPath,
  listRepoFiles,
  normalizeRepoPath,
  optionValue,
  readFileAtCommit,
  readRepoFile,
  resolveBase,
  todayUtc,
} from './ratchet-utils.mjs';

export const BASELINE_PATH = 'config/env-var-count-budget.json';
export const DOMAIN_ROOTS = Object.freeze({
  server: ['server/src'],
  'acs-orchestrator': ['acs-orchestrator/src'],
  'hand-server': ['hand-server/src'],
  'shared/runtime': ['shared/src', 'workspace-shared'],
  'web build-time': ['web/src', 'web/scripts', 'web/vite.config.ts', 'web/vite.config.js'],
  'deployment/scripts': ['scripts', 'server/scripts', 'server/stryker.conf.mjs'],
  packages: ['packages'],
});
export const DOMAINS = Object.freeze(Object.keys(DOMAIN_ROOTS));
const ALL_ROOTS = [...new Set(Object.values(DOMAIN_ROOTS).flat())];
const SOURCE_EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/u;
const EXCLUDED = new Set(['node_modules', 'dist', 'coverage', 'generated', '__generated__', 'cache', '.cache']);
const HELPER_NAMES = '(?:getEnv|requireEnv|readEnv|configEnv|fromEnv|optionalEnv|envString|envNumber|envBoolean)';
const NAME = '[A-Z][A-Z0-9_]*';

export function domainOf(value) {
  const file = normalizeRepoPath(value);
  for (const domain of DOMAINS) {
    if (DOMAIN_ROOTS[domain].some((root) => file === root || file.startsWith(`${root}/`))) return domain;
  }
  return null;
}

export function isCountedPath(value) {
  const file = normalizeRepoPath(value);
  return Boolean(domainOf(file))
    && SOURCE_EXTENSION.test(file)
    && !isTestPath(file)
    && !file.split('/').some((segment) => EXCLUDED.has(segment));
}

export function scanSource(source) {
  const names = new Set();
  const dynamic = [];
  const addMatches = (regex, index = 1) => {
    for (const match of source.matchAll(regex)) names.add(match[index]);
  };

  addMatches(new RegExp(`\\bprocess\\.env\\.(${NAME})\\b`, 'gu'));
  addMatches(new RegExp(`\\bprocess\\.env\\[\\s*['\"](${NAME})['\"]\\s*\\]`, 'gu'));
  addMatches(new RegExp(`\\bimport\\.meta\\.env\\.(${NAME})\\b`, 'gu'));
  addMatches(new RegExp(`\\bimport\\.meta\\.env\\[\\s*['\"](${NAME})['\"]\\s*\\]`, 'gu'));
  addMatches(new RegExp(`\\b${HELPER_NAMES}\\s*\\(\\s*['\"](${NAME})['\"]`, 'gu'));

  const centralized = /\b(?:ENV(?:IRONMENT)?_(?:NAMES|VARIABLES|ALLOWLIST|KEYS)|REQUIRED_ENV|OPTIONAL_ENV)\b\s*=\s*\[([\s\S]*?)\]/gu;
  for (const match of source.matchAll(centralized)) {
    for (const item of match[1].matchAll(new RegExp(`['\"](${NAME})['\"]`, 'gu'))) names.add(item[1]);
  }

  for (const match of source.matchAll(/\b(?:process\.env|import\.meta\.env)\[\s*([^'"\]\n][^\]\n]*)\s*\]/gu)) {
    dynamic.push(match[1].trim());
  }
  for (const match of source.matchAll(new RegExp(`\\b${HELPER_NAMES}\\s*\\(\\s*([^'\"\\s][^,\\)\\n]*)`, 'gu'))) {
    dynamic.push(match[1].trim());
  }
  return { names, dynamic: [...new Set(dynamic)] };
}

export function collectEnvNames(root = process.cwd(), { staged = false } = {}) {
  const domains = Object.fromEntries(DOMAINS.map((domain) => [domain, new Set()]));
  const dynamic = [];
  for (const file of listRepoFiles(root, ALL_ROOTS, { staged })) {
    if (!isCountedPath(file)) continue;
    const scan = scanSource(readRepoFile(root, file, { staged }));
    for (const name of scan.names) domains[domainOf(file)].add(name);
    dynamic.push(...scan.dynamic.map((expression) => `${file}: ${expression}`));
  }
  return { domains, dynamic: [...new Set(dynamic)].sort() };
}

export function snapshotEnv(collection, reason) {
  return {
    schemaVersion: 1,
    reason,
    updatedAt: todayUtc(),
    domains: Object.fromEntries(DOMAINS.map((domain) => {
      const names = [...collection.domains[domain]].sort();
      return [domain, { budget: names.length, names }];
    })),
  };
}

export function parseEnvBaseline(text, source = BASELINE_PATH, { backfillNewDomains = false } = {}) {
  const value = JSON.parse(text);
  if (value.schemaVersion !== 1 || typeof value.reason !== 'string' || !value.reason.trim() || typeof value.updatedAt !== 'string') {
    throw new Error(`${source} must contain schemaVersion=1, reason, and updatedAt`);
  }
  if (!value.domains || typeof value.domains !== 'object') throw new Error(`${source} has no domains object`);
  for (const domain of DOMAINS) {
    const entry = value.domains[domain];
    // 新增一个治理域时，merge-base 快照里必然还没有这个域。只有读取 merge-base 快照
    // 才允许回填成空预算：该域此后拿到的每个名字都算相对 merge-base 的扩张，
    // 依旧要求 baseline 里写下新的显式理由，棘轮语义不被削弱。
    if (!entry && backfillNewDomains) {
      value.domains[domain] = { budget: 0, names: [] };
      continue;
    }
    if (!entry || !Number.isSafeInteger(entry.budget) || entry.budget < 0 || !Array.isArray(entry.names)) {
      throw new Error(`${source} has invalid domain ${domain}`);
    }
    if (entry.names.some((name) => typeof name !== 'string' || !new RegExp(`^${NAME}$`, 'u').test(name))) {
      throw new Error(`${source} has invalid environment name in ${domain}`);
    }
    if (new Set(entry.names).size !== entry.names.length || entry.budget !== entry.names.length) {
      throw new Error(`${source} ${domain} budget must equal its distinct sorted name count`);
    }
  }
  return value;
}

export function evaluateEnv({ collection, baseline, baseBaseline = null, prune = false }) {
  const errors = [];
  const changes = [];
  // 相对 merge-base 写了新的显式理由 ＝ 经过审阅的扩张，与 web startup ratchet 同一套语义。
  // 环境变量数量在持续加功能的运行时里必然增长，纯棘轮会把「新配置项」变成不可能事件；
  // 但扩张必须在 baseline 里留下一条新理由，未写理由的增长依旧阻断。
  const reasoned = Boolean(baseBaseline) && baseline.reason !== baseBaseline.reason;
  for (const domain of DOMAINS) {
    const actual = collection.domains[domain];
    const entry = baseline.domains[domain];
    const recorded = new Set(entry.names);
    const added = [...actual].filter((name) => !recorded.has(name)).sort();
    const removed = [...recorded].filter((name) => !actual.has(name)).sort();
    if (actual.size > entry.budget) errors.push(`${domain}: ${actual.size} names > budget ${entry.budget}`);
    if (added.length) errors.push(`${domain} added: ${added.join(', ')}`);
    if (removed.length) changes.push(`${domain} removed: ${removed.join(', ')}`);
    if (removed.length && !prune) errors.push(`${domain} stale: ${removed.join(', ')}; run --prune`);
    if (baseBaseline && !reasoned) {
      const baseEntry = baseBaseline.domains[domain];
      const baseNames = new Set(baseEntry.names);
      const expanded = entry.names.filter((name) => !baseNames.has(name));
      if (entry.budget > baseEntry.budget) {
        errors.push(`${domain} budget expanded ${entry.budget} > merge-base ${baseEntry.budget} without a new explicit reason`);
      }
      if (expanded.length) {
        errors.push(`${domain} baseline added names vs merge-base without a new explicit reason: ${expanded.join(', ')}`);
      }
    }
  }
  return { errors, changes };
}

function baselineFrom(root, staged) {
  const file = path.join(root, BASELINE_PATH);
  if (staged) return parseEnvBaseline(readRepoFile(root, BASELINE_PATH, { staged }), `index:${BASELINE_PATH}`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${BASELINE_PATH}; use --init for the explicit initial snapshot`);
  return parseEnvBaseline(fs.readFileSync(file, 'utf8'));
}

export function runEnvRatchet(root = process.cwd(), argv = []) {
  const staged = argv.includes('--staged');
  const prune = argv.includes('--prune');
  const init = argv.includes('--init');
  const update = argv.includes('--update-baseline');
  const reason = optionValue(argv, '--reason');
  if ([init, prune, update].filter(Boolean).length > 1) throw new Error('--init, --prune and --update-baseline are separate operations');
  if (init && staged) throw new Error('--init snapshots the working tree; stage the generated baseline afterward');
  if (update && staged) throw new Error('--update-baseline snapshots the working tree; stage the generated baseline afterward');
  const baselineFile = path.join(root, BASELINE_PATH);
  const collection = collectEnvNames(root, { staged });

  if (init) {
    if (!reason) throw new Error('--init requires --reason');
    if (fs.existsSync(baselineFile)) throw new Error(`${BASELINE_PATH} already exists; initial generation never overwrites it`);
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, `${JSON.stringify(snapshotEnv(collection, reason), null, 2)}\n`);
    return { message: `Initialized ${BASELINE_PATH}`, collection };
  }

  const baseline = baselineFrom(root, staged);
  if (update) {
    if (!reason) throw new Error('--update-baseline requires --reason (state why each new environment variable is necessary)');
    if (reason.trim() === baseline.reason.trim()) throw new Error('--update-baseline requires a reason distinct from the recorded one');
    fs.writeFileSync(baselineFile, `${JSON.stringify(snapshotEnv(collection, reason), null, 2)}\n`);
    return { message: `Updated ${BASELINE_PATH} with explicit reason`, collection, changes: [] };
  }

  const resolvedBase = resolveBase(root, optionValue(argv, '--base'));
  const baseText = readFileAtCommit(root, resolvedBase.sha, BASELINE_PATH);
  const baseBaseline =
    baseText === null
      ? null
      : parseEnvBaseline(baseText, `${resolvedBase.sha}:${BASELINE_PATH}`, { backfillNewDomains: true });
  const result = evaluateEnv({ collection, baseline, baseBaseline, prune });
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  if (prune) {
    const pruneReason = reason ?? `Ratchet prune: ${result.changes.join('; ') || 'normalize current distinct names'}`;
    fs.writeFileSync(baselineFile, `${JSON.stringify(snapshotEnv(collection, pruneReason), null, 2)}\n`);
  }
  return {
    message: `${prune ? 'Pruned' : 'Checked'} env-var ratchet: ${DOMAINS.map((domain) => `${domain}=${collection.domains[domain].size}`).join(', ')}`,
    collection,
    changes: result.changes,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const result = runEnvRatchet(process.cwd(), process.argv.slice(2));
    console.log(result.message);
    if (result.collection.dynamic.length) console.warn(`Dynamic environment names (reported, not counted):\n${result.collection.dynamic.join('\n')}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
