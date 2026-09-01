#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ENVIRONMENTS, parseArgs } from './effective-config-lib.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export function validateEffectiveConfig(value) {
  const errors = [];
  if (value?.schemaVersion !== 1) errors.push('schemaVersion must equal 1');
  if (!ENVIRONMENTS.has(value?.environment)) errors.push('environment is invalid');
  if (!DIGEST.test(value?.effectiveConfigFingerprint ?? ''))
    errors.push('effectiveConfigFingerprint is invalid');
  if (!DIGEST.test(value?.capabilityFingerprint ?? ''))
    errors.push('capabilityFingerprint is invalid');
  if (!['ready', 'missing', 'legacy_inline', 'unknown'].includes(value?.secretReadiness))
    errors.push('secretReadiness is invalid');
  if (!value?.config || typeof value.config !== 'object' || Array.isArray(value.config))
    errors.push('config must be an object');
  for (const secret of value?.secrets ?? []) {
    if (typeof secret?.path !== 'string') errors.push('secret path is invalid');
    if (!['ref', 'inline_legacy', 'missing', 'environment'].includes(secret?.state))
      errors.push(`secret state is invalid at ${secret?.path ?? '?'}`);
  }
  return errors;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.input) throw new Error('usage: validate-effective-config.mjs --input <export.json>');
  const value = JSON.parse(await readFile(resolve(options.input), 'utf8'));
  const errors = validateEffectiveConfig(value);
  if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 2;
  } else {
    process.stdout.write('effective config inventory is valid\n');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
