#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  digest,
  ENVIRONMENTS,
  loadOptionalStore,
  overallSecretReadiness,
  parseArgs,
  pickPaths,
  readJsonc,
  redactConfig,
  SCHEMA_VERSION,
} from './effective-config-lib.mjs';

const DEFAULT_STORES = [
  ['egress', 'data/egress-config.json'],
  ['signup', 'data/signup-config.json'],
  ['tenants', 'tenants.json'],
  ['skills', 'skills-config.json'],
  ['mcp', 'mcp-config.json'],
];

export async function exportEffectiveConfig(options) {
  const environment = options.environment;
  if (!ENVIRONMENTS.has(environment)) throw new Error(`Unsupported environment: ${environment}`);
  const configPath = resolve(options.config);
  const rawConfig = await readJsonc(configPath);
  const contractPath = resolve(options.contract ?? 'config/governance/capability-contract.json');
  const capabilityContract = JSON.parse(await readFile(contractPath, 'utf8'));
  const secrets = [];
  const config = redactConfig(rawConfig, 'config', secrets);
  const stores = {};
  const root = options.root ? resolve(options.root) : resolve(configPath, '..');
  for (const [name, relativePath] of DEFAULT_STORES) {
    const raw = await loadOptionalStore(resolve(root, relativePath));
    stores[name] =
      raw === undefined
        ? { state: 'missing' }
        : { state: 'present', value: redactConfig(raw, `stores.${name}.value`, secrets) };
  }
  let runtime = {};
  if (options.runtimeIdentity) {
    const identity = await loadOptionalStore(resolve(options.runtimeIdentity));
    if (!identity)
      throw new Error(`Runtime identity is missing: ${resolve(options.runtimeIdentity)}`);
    if (identity.environment !== environment) {
      throw new Error(
        `Runtime identity environment mismatch: expected ${environment}, got ${identity.environment ?? 'missing'}`,
      );
    }
    runtime = identity ? redactConfig(identity, 'runtime', secrets) : { state: 'missing' };
  } else if (environment === 'production') {
    throw new Error('--runtimeIdentity is required for production export identity attestation');
  }
  const capability = pickPaths(rawConfig, capabilityContract.paths ?? []);
  return {
    schemaVersion: SCHEMA_VERSION,
    environment,
    effectiveConfigFingerprint: digest(rawConfig),
    capabilityFingerprint: digest(capability),
    secretReadiness: overallSecretReadiness(secrets),
    exportedAt: new Date().toISOString(),
    config,
    stores,
    runtime,
    secrets: secrets.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.config || !options.environment) {
    throw new Error(
      'usage: export-effective-config.mjs --config <path> --environment <name> [--root <path>] [--runtimeIdentity <path>] [--output <new-path>]',
    );
  }
  const report = await exportEffectiveConfig(options);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(resolve(options.output), body, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
