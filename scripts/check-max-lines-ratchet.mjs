#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findRenames,
  isTestPath,
  listRepoFiles,
  normalizeRepoPath,
  optionValue,
  readFileAtCommit,
  readRepoFile,
  resolveBase,
} from './ratchet-utils.mjs';

export const SOURCE_ROOTS = ['server/src', 'web/src', 'shared/src', 'hand-server/src', 'acs-orchestrator/src'];
export const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);
export const THRESHOLDS = Object.freeze({ production: 1000, test: 800 });
export const BASELINE_PATH = 'config/max-lines-baseline.txt';
const EXCLUDED_SEGMENTS = new Set(['node_modules', 'dist', 'generated', '__generated__', 'coverage', 'cache', '.cache']);

export function isGovernedSourcePath(value) {
  const file = normalizeRepoPath(value);
  const segments = file.split('/');
  return SOURCE_ROOTS.some((root) => file.startsWith(`${root}/`))
    && SOURCE_EXTENSIONS.has(path.posix.extname(file))
    && !segments.some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

export function scopeFor(file) {
  return isTestPath(file) ? 'test' : 'production';
}

export function countLines(source) {
  if (source.length === 0) return 0;
  const normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const lines = normalized.split('\n').length;
  return normalized.endsWith('\n') ? lines - 1 : lines;
}

export function collectOverThreshold(root = process.cwd(), { staged = false } = {}) {
  const entries = new Map();
  for (const file of listRepoFiles(root, SOURCE_ROOTS, { staged })) {
    if (!isGovernedSourcePath(file)) continue;
    const scope = scopeFor(file);
    const lines = countLines(readRepoFile(root, file, { staged }));
    if (lines > THRESHOLDS[scope]) entries.set(file, { lines, scope });
  }
  return entries;
}

export function parseBaseline(text, source = BASELINE_PATH) {
  const result = new Map();
  for (const [index, raw] of text.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [fileValue, limitValue, scope, extra] = line.split(/\s+/u);
    const file = normalizeRepoPath(fileValue ?? '');
    if (!file || !/^\d+$/u.test(limitValue ?? '') || !['production', 'test'].includes(scope) || extra) {
      throw new Error(`${source}:${index + 1} must be: repo-relative-path integer production|test`);
    }
    if (result.has(file)) throw new Error(`${source}:${index + 1} duplicates ${file}`);
    result.set(file, { lines: Number(limitValue), scope });
  }
  return result;
}

export function formatBaseline(entries) {
  const rows = [...entries]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, value]) => `${file}\t${value.lines}\t${value.scope}`);
  return [
    '# Source file ratchet baseline. Physical lines are CRLF-normalized; a final newline is not a line.',
    '# Thresholds: production=1000 (above production p95=821), test=800 (above test p95=667).',
    '# Generated/build/cache output is excluded because it is not maintained source.',
    '# Format: repo-relative-path max-lines scope',
    '# Existing over-threshold files are grandfathered; entries may only shrink or be pruned.',
    '',
    ...rows,
    '',
  ].join('\n');
}

function baselineFrom(root, staged) {
  const file = path.join(root, BASELINE_PATH);
  if (staged) return parseBaseline(readRepoFile(root, BASELINE_PATH, { staged }), `index:${BASELINE_PATH}`);
  if (!fs.existsSync(file)) throw new Error(`Missing ${BASELINE_PATH}; use --init for the explicit initial snapshot`);
  return parseBaseline(fs.readFileSync(file, 'utf8'));
}

export function evaluateMaxLines({ current, baseline, baseBaseline, renames, prune = false }) {
  const errors = [];
  const lowered = [];
  const consumedBaselinePaths = new Set();

  for (const [file, value] of current) {
    const owner = baseline.has(file) ? file : renames.get(file);
    const previous = owner ? baseline.get(owner) : undefined;
    if (!previous) {
      errors.push(`NEW over-threshold ${file}: ${value.lines} lines > ${THRESHOLDS[value.scope]} ${value.scope} threshold`);
      continue;
    }
    consumedBaselinePaths.add(owner);
    if (previous.scope !== value.scope) errors.push(`SCOPE CHANGED ${file}: ${previous.scope} -> ${value.scope}`);
    if (value.lines > previous.lines) errors.push(`GROWN ${file}: ${value.lines} > baseline ${previous.lines}`);
    if (value.lines < previous.lines) lowered.push(`${file}: ${previous.lines} -> ${value.lines}`);
  }

  for (const file of baseline.keys()) {
    if (!consumedBaselinePaths.has(file)) errors.push(`STALE baseline ${file}; use --prune after the file is removed or drops below threshold`);
  }

  if (baseBaseline) {
    for (const [file, value] of baseline) {
      const baseOwner = baseBaseline.has(file) ? file : renames.get(file);
      const baseValue = baseOwner ? baseBaseline.get(baseOwner) : undefined;
      if (baseValue && value.lines > baseValue.lines) {
        errors.push(`BASELINE EXPANDED ${file}: ${value.lines} > merge-base ${baseValue.lines}`);
      }
    }
  }

  if (!prune) errors.push(...lowered.map((item) => `LOWERED ${item}; run --prune to ratchet down`));
  return { errors, lowered };
}

export function runMaxLines(root = process.cwd(), argv = []) {
  const staged = argv.includes('--staged');
  const prune = argv.includes('--prune');
  const init = argv.includes('--init');
  if (init && prune) throw new Error('--init and --prune are separate operations');
  if (init && staged) throw new Error('--init snapshots the working tree; stage the generated baseline afterward');

  const baselineFile = path.join(root, BASELINE_PATH);
  const current = collectOverThreshold(root, { staged });
  if (init) {
    if (fs.existsSync(baselineFile)) throw new Error(`${BASELINE_PATH} already exists; initial generation never overwrites it`);
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, formatBaseline(current));
    return { message: `Initialized ${BASELINE_PATH} with ${current.size} grandfathered files`, current };
  }

  const baseline = baselineFrom(root, staged);
  const requestedBase = optionValue(argv, '--base');
  const resolvedBase = resolveBase(root, requestedBase);
  const baseText = readFileAtCommit(root, resolvedBase.sha, BASELINE_PATH);
  const baseBaseline = baseText === null ? null : parseBaseline(baseText, `${resolvedBase.sha}:${BASELINE_PATH}`);
  const renames = findRenames(root, resolvedBase.sha, SOURCE_ROOTS, { staged });
  const result = evaluateMaxLines({ current, baseline, baseBaseline, renames, prune });

  const blocking = result.errors.filter((error) => prune && error.startsWith('LOWERED ') ? false : true);
  if (blocking.length) throw new Error(blocking.join('\n'));
  if (prune) fs.writeFileSync(baselineFile, formatBaseline(current));
  return {
    message: `${prune ? 'Pruned' : 'Checked'} max-lines ratchet: ${current.size} grandfathered files`,
    current,
    lowered: result.lowered,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const result = runMaxLines(process.cwd(), process.argv.slice(2));
    console.log(result.message);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
