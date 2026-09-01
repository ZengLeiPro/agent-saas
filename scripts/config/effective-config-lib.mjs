import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { parse as parseJsonc, printParseErrorCode } from 'jsonc-parser';

export const SCHEMA_VERSION = 1;
export const ENVIRONMENTS = new Set(['development', 'staging', 'production', 'test']);

const SECRET_KEY =
  /(secret|password|token|api[-_]?key|private[-_]?key|authorization|credential)$/iu;
const SECRET_REF_KEY = /(secret|token|api[-_]?key|private[-_]?key|credential).*(ref|id)$/iu;
const SAFE_SECRET_METADATA = new Set([
  'tokenExpiresIn',
  'maxOutputTokens',
  'maxTokens',
  'tokenBudget',
  'credentialCount',
]);

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

export async function readJsonc(path) {
  const text = await readFile(path, 'utf8');
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !value || typeof value !== 'object' || Array.isArray(value)) {
    const detail = errors
      .map((error) => `${printParseErrorCode(error.error)}@${error.offset}`)
      .join(', ');
    throw new Error(`Invalid JSON/JSONC at ${path}${detail ? `: ${detail}` : ''}`);
  }
  return value;
}

function secretState(key, value) {
  if (SAFE_SECRET_METADATA.has(key)) return undefined;
  if (SECRET_REF_KEY.test(key)) {
    return value ? 'ref' : 'missing';
  }
  if (SECRET_KEY.test(key)) {
    if (value === undefined || value === null || value === '') return 'missing';
    return 'inline_legacy';
  }
  return undefined;
}

export function redactConfig(value, path = 'config', secrets = []) {
  if (Array.isArray(value))
    return value.map((item, index) => redactConfig(item, `${path}.${index}`, secrets));
  if (!value || typeof value !== 'object') return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const state = secretState(key, child);
    if (state) {
      secrets.push({ path: childPath, state });
      output[key] = { state };
      continue;
    }
    output[key] = redactConfig(child, childPath, secrets);
  }
  return output;
}

export function pickPaths(source, paths) {
  const output = {};
  for (const path of paths) {
    const segments = path.split('.');
    let cursor = source;
    for (const segment of segments) {
      if (!cursor || typeof cursor !== 'object' || !(segment in cursor)) {
        cursor = undefined;
        break;
      }
      cursor = cursor[segment];
    }
    output[path] = cursor ?? null;
  }
  return output;
}

export function overallSecretReadiness(secrets) {
  if (secrets.some((item) => item.state === 'missing')) return 'missing';
  if (secrets.some((item) => item.state === 'inline_legacy')) return 'legacy_inline';
  if (secrets.length === 0) return 'unknown';
  return 'ready';
}

export async function loadOptionalStore(path) {
  if (!path) return undefined;
  try {
    return await readJsonc(resolve(path));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

export function flatten(value, prefix = '', output = new Map()) {
  if (Array.isArray(value)) {
    if (value.length === 0) output.set(prefix, []);
    value.forEach((item, index) =>
      flatten(item, prefix ? `${prefix}.${index}` : String(index), output),
    );
    return output;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) output.set(prefix, {});
    entries.forEach(([key, child]) => flatten(child, prefix ? `${prefix}.${key}` : key, output));
    return output;
  }
  output.set(prefix, value);
  return output;
}

export function pathMatches(pattern, path) {
  const patternSegments = pattern.split('.');
  const pathSegments = path.split('.');
  function match(patternIndex, pathIndex) {
    if (patternIndex === patternSegments.length) return pathIndex === pathSegments.length;
    const segment = patternSegments[patternIndex];
    if (segment === '**') {
      if (patternIndex === patternSegments.length - 1) return true;
      for (let cursor = pathIndex; cursor <= pathSegments.length; cursor++) {
        if (match(patternIndex + 1, cursor)) return true;
      }
      return false;
    }
    if (pathIndex >= pathSegments.length) return false;
    if (segment !== '*' && segment !== pathSegments[pathIndex]) return false;
    return match(patternIndex + 1, pathIndex + 1);
  }
  return match(0, 0);
}

export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const current = argv[index];
    if (!current.startsWith('--')) throw new Error(`Unexpected argument: ${current}`);
    const name = current.slice(2);
    if (['write', 'fix', 'sync', 'apply'].includes(name)) {
      throw new Error(
        `--${name} is intentionally unsupported; configuration governance is read-only`,
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
    options[name] = value;
    index++;
  }
  return options;
}
