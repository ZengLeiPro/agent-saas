#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { optionValue, readFileAtCommit, resolveBase, todayUtc } from './ratchet-utils.mjs';

export const BASELINE_PATH = 'config/web-startup-budget-baseline.json';
export const METRIC_KEYS = Object.freeze([
  'startupJsRequests',
  'startupCssRequests',
  'startupJsGzipBytes',
  'startupCssGzipBytes',
  'startupJsBrotliBytes',
  'startupCssBrotliBytes',
  'largestJsGzipBytes',
  'largestCssGzipBytes',
  'largestJsBrotliBytes',
  'largestCssBrotliBytes',
]);
export const DEFAULT_CEILINGS = Object.freeze({
  startupJsRequests: 20,
  startupCssRequests: 4,
  startupJsGzipBytes: 600_000,
  startupCssGzipBytes: 120_000,
  largestJsGzipBytes: 450_000,
  largestCssGzipBytes: 120_000,
});
export const DEFAULT_TOLERANCE = Object.freeze({ requests: 0, bytes: 1024 });

function attributes(tag) {
  const result = new Map();
  for (const match of tag.matchAll(/\b([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

export function assetFromUrl(value) {
  if (!value || /^(?:data:|https?:\/\/|\/\/)/iu.test(value)) return null;
  const clean = value.split(/[?#]/u)[0].replaceAll('\\', '/');
  if (!clean || clean.includes('\0')) return null;
  const decoded = decodeURIComponent(clean);
  if (decoded.split('/').includes('..')) return null;
  return decoded.replace(/^\.?\//u, '').replace(/^\/+/, '');
}

export function startupAssets(html) {
  const js = new Set();
  const css = new Set();
  for (const match of html.matchAll(/<script\b[^>]*>/giu)) {
    const src = attributes(match[0]).get('src');
    const asset = assetFromUrl(src);
    if (asset && /\.m?js$/iu.test(asset)) js.add(asset);
  }
  for (const match of html.matchAll(/<link\b[^>]*>/giu)) {
    const attrs = attributes(match[0]);
    const rel = (attrs.get('rel') ?? '').toLowerCase().split(/\s+/u);
    const asset = assetFromUrl(attrs.get('href'));
    if (rel.includes('stylesheet') && asset && /\.css$/iu.test(asset)) css.add(asset);
  }
  return { js: [...js], css: [...css] };
}

function compressionMetrics(dist, assets) {
  const files = assets.map((asset) => {
    const file = path.resolve(dist, asset);
    const relative = path.relative(path.resolve(dist), file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Startup asset escapes dist: ${asset}`);
    if (!fs.existsSync(file)) throw new Error(`index.html references missing startup asset ${asset}`);
    const bytes = fs.readFileSync(file);
    return {
      path: asset,
      rawBytes: bytes.length,
      gzipBytes: zlib.gzipSync(bytes, { level: 9, mtime: 0 }).length,
      brotliBytes: zlib.brotliCompressSync(bytes, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
      }).length,
    };
  });
  return {
    requests: files.length,
    gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
    brotliBytes: files.reduce((sum, file) => sum + file.brotliBytes, 0),
    largestGzipBytes: Math.max(0, ...files.map((file) => file.gzipBytes)),
    largestBrotliBytes: Math.max(0, ...files.map((file) => file.brotliBytes)),
    largest: files.toSorted((left, right) => right.gzipBytes - left.gzipBytes)[0]?.path ?? null,
    files,
  };
}

export function collectMetrics(dist) {
  const index = path.join(dist, 'index.html');
  if (!fs.existsSync(index)) throw new Error(`Missing ${index}; run the production Web build first (this checker never builds)`);
  const startup = startupAssets(fs.readFileSync(index, 'utf8'));
  const js = compressionMetrics(dist, startup.js);
  const css = compressionMetrics(dist, startup.css);
  return {
    startupJsRequests: js.requests,
    startupCssRequests: css.requests,
    startupJsGzipBytes: js.gzipBytes,
    startupCssGzipBytes: css.gzipBytes,
    startupJsBrotliBytes: js.brotliBytes,
    startupCssBrotliBytes: css.brotliBytes,
    largestJsGzipBytes: js.largestGzipBytes,
    largestCssGzipBytes: css.largestGzipBytes,
    largestJsBrotliBytes: js.largestBrotliBytes,
    largestCssBrotliBytes: css.largestBrotliBytes,
    largestJs: js.largest,
    largestCss: css.largest,
  };
}

export function parseWebBaseline(text, source = BASELINE_PATH) {
  const value = JSON.parse(text);
  if (value.schemaVersion !== 1 || typeof value.reason !== 'string' || !value.reason.trim() || typeof value.updatedAt !== 'string') {
    throw new Error(`${source} must contain schemaVersion=1, reason, and updatedAt`);
  }
  for (const key of METRIC_KEYS) {
    if (!Number.isSafeInteger(value.metrics?.[key]) || value.metrics[key] < 0) throw new Error(`${source} has invalid metrics.${key}`);
  }
  for (const [key, ceiling] of Object.entries(DEFAULT_CEILINGS)) {
    if (!Number.isSafeInteger(value.ceilings?.[key]) || value.ceilings[key] !== ceiling) {
      throw new Error(`${source} ceilings.${key} must remain the reviewed absolute ceiling ${ceiling}`);
    }
  }
  if (value.tolerance?.requests !== DEFAULT_TOLERANCE.requests || value.tolerance?.bytes !== DEFAULT_TOLERANCE.bytes) {
    throw new Error(`${source} tolerance must be requests=0 and bytes=1024`);
  }
  return value;
}

function toleranceFor(key, tolerance) {
  return key.endsWith('Requests') ? tolerance.requests : tolerance.bytes;
}

export function evaluateWeb(metrics, baseline, baseBaseline = null) {
  const errors = [];
  const lowered = [];
  const increased = [];
  for (const [key, ceiling] of Object.entries(baseline.ceilings)) {
    if (metrics[key] > ceiling) errors.push(`${key} ${metrics[key]} > absolute ceiling ${ceiling}`);
  }
  for (const key of METRIC_KEYS) {
    const tolerance = toleranceFor(key, baseline.tolerance);
    const recorded = baseline.metrics[key];
    if (metrics[key] > recorded + tolerance) errors.push(`${key} ${metrics[key]} > baseline ${recorded} + tolerance ${tolerance}`);
    if (metrics[key] < recorded - tolerance) lowered.push(`${key}: ${recorded} -> ${metrics[key]}`);
    if (baseBaseline && recorded > baseBaseline.metrics[key] + tolerance) increased.push(key);
  }
  if (baseBaseline && increased.length && baseline.reason === baseBaseline.reason) {
    errors.push(`Baseline increased vs merge-base without a new explicit reason: ${increased.join(', ')}`);
  }
  return { errors, lowered, increased };
}

function baselineDocument(metrics, reason) {
  return {
    schemaVersion: 1,
    metrics,
    tolerance: DEFAULT_TOLERANCE,
    ceilings: DEFAULT_CEILINGS,
    reason,
    updatedAt: todayUtc(),
  };
}

export function runWebBudget(root = process.cwd(), argv = []) {
  const distValue = optionValue(argv, '--dist') ?? 'web/dist';
  const baselineValue = optionValue(argv, '--baseline') ?? BASELINE_PATH;
  const reason = optionValue(argv, '--reason');
  const update = argv.includes('--update-baseline');
  const init = argv.includes('--init-baseline');
  if (update && init) throw new Error('--update-baseline and --init-baseline are separate operations');
  const dist = path.resolve(root, distValue);
  const baselineFile = path.resolve(root, baselineValue);
  const metrics = collectMetrics(dist);

  if (init) {
    if (!reason) throw new Error('--init-baseline requires --reason');
    if (fs.existsSync(baselineFile)) throw new Error(`${baselineValue} already exists; initial generation never overwrites it`);
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, `${JSON.stringify(baselineDocument(metrics, reason), null, 2)}\n`);
    return { metrics, lowered: [], message: `Initialized ${baselineValue}` };
  }

  if (!fs.existsSync(baselineFile)) throw new Error(`Missing ${baselineValue}; use --init-baseline --reason "..." after a production build`);
  const baseline = parseWebBaseline(fs.readFileSync(baselineFile, 'utf8'), baselineValue);
  if (update) {
    if (!reason) throw new Error('--update-baseline requires --reason (including necessary growth rationale)');
    const ceilingErrors = evaluateWeb(metrics, { ...baseline, metrics, reason }).errors;
    if (ceilingErrors.length) throw new Error(ceilingErrors.join('\n'));
    fs.writeFileSync(baselineFile, `${JSON.stringify(baselineDocument(metrics, reason), null, 2)}\n`);
    return { metrics, lowered: [], message: `Updated ${baselineValue} with explicit reason` };
  }

  let baseBaseline = null;
  if (baselineValue === BASELINE_PATH) {
    const base = resolveBase(root, optionValue(argv, '--base'));
    const baseText = readFileAtCommit(root, base.sha, BASELINE_PATH);
    if (baseText !== null) baseBaseline = parseWebBaseline(baseText, `${base.sha}:${BASELINE_PATH}`);
  }
  const result = evaluateWeb(metrics, baseline, baseBaseline);
  if (result.errors.length) throw new Error(result.errors.join('\n'));
  return {
    metrics,
    lowered: result.lowered,
    message: `Web startup budget OK: JS ${metrics.startupJsRequests} req/${metrics.startupJsGzipBytes} gzip B; CSS ${metrics.startupCssRequests} req/${metrics.startupCssGzipBytes} gzip B`,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const result = runWebBudget(process.cwd(), process.argv.slice(2));
    console.log(result.message);
    console.log(JSON.stringify(result.metrics, null, 2));
    if (result.lowered.length) console.warn(`Ratchet hint: lower the baseline with --update-baseline --reason "...":\n${result.lowered.join('\n')}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
