#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { parseAppConfig } from '../../server/src/app/config.js';
import { assertRuntimeEnvironmentSafety } from '../../server/src/release/environmentSafety.js';

const [configPath, processCwd] = process.argv.slice(2);
if (!configPath || !processCwd) {
  throw new Error('usage: validate-runtime-config.ts <config-path> <server-process-cwd>');
}

const config = parseAppConfig(JSON.parse(readFileSync(configPath, 'utf8')));
const identity = assertRuntimeEnvironmentSafety(config, process.env, { processCwd });
if (identity.environment !== 'staging' || identity.safetyAttested !== true) {
  throw new Error('Staging runtime identity was not safety-attested');
}

process.stdout.write('staging-runtime-config-valid\n');
