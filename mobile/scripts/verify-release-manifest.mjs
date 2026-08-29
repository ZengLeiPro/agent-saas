#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const {
  RELEASE_MANIFEST_PATH,
  REPOSITORY_ROOT,
  loadRepositoryInputs,
  readJson,
  resolveBuildContext,
  verifyRepositoryReleaseConfiguration,
} = require('./release-manifest.cjs');

function parseArguments(argv) {
  const options = {
    profile: undefined,
    gitSha: undefined,
    manifestPath: RELEASE_MANIFEST_PATH,
    expoConfigPath: undefined,
    output: 'summary',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (
      argument === '--profile' ||
      argument === '--git-sha' ||
      argument === '--manifest' ||
      argument === '--expo-config'
    ) {
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      if (argument === '--profile') options.profile = value;
      if (argument === '--git-sha') options.gitSha = value;
      if (argument === '--manifest') options.manifestPath = resolve(process.cwd(), value);
      if (argument === '--expo-config') options.expoConfigPath = resolve(process.cwd(), value);
      continue;
    }
    if (argument === '--print-artifact-identity') {
      options.output = 'artifact';
      continue;
    }
    if (argument === '--print-marketing-version') {
      options.output = 'marketingVersion';
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

function assertRootGuard() {
  const staleRootAppJson = resolve(REPOSITORY_ROOT, 'app.json');
  if (existsSync(staleRootAppJson)) {
    throw new Error('root app.json must not exist; mobile/ is the only Expo/EAS project root');
  }
  const rootGuardPath = resolve(REPOSITORY_ROOT, 'app.config.js');
  if (!existsSync(rootGuardPath)) throw new Error('root app.config.js fail-fast guard is missing');
  const rootGuard = readFileSync(rootGuardPath, 'utf8');
  if (
    !rootGuard.includes('[M10-03] Invalid Expo/EAS project root') ||
    !rootGuard.includes('mobile/')
  ) {
    throw new Error('root app.config.js does not contain the M10-03 mobile project-root guard');
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  assertRootGuard();
  const inputs = loadRepositoryInputs(options.manifestPath);
  const context = resolveBuildContext({
    environment: process.env,
    explicitProfile: options.profile,
    explicitGitSha: options.gitSha,
  });
  const loadedExpoConfig = options.expoConfigPath ? readJson(options.expoConfigPath) : undefined;
  const expoConfig = loadedExpoConfig?.expo ?? loadedExpoConfig;
  const artifactIdentity = verifyRepositoryReleaseConfiguration({
    ...inputs,
    context,
    expoConfig,
  });

  if (options.output === 'marketingVersion') {
    process.stdout.write(`${inputs.manifest.version.marketingVersion}\n`);
    return;
  }
  if (options.output === 'artifact') {
    process.stdout.write(`${JSON.stringify(artifactIdentity, null, 2)}\n`);
    return;
  }
  console.log(
    `M10-03 release manifest checks passed (profile=${context.profile}, sourceGitSha=${context.sourceGitSha ?? 'unavailable'})`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = message.startsWith('[M10-03]') ? '' : '[M10-03] ';
  console.error(`M10-03 release manifest checks failed: ${prefix}${message}`);
  process.exitCode = 1;
}
