#!/usr/bin/env node
import { resolve } from 'node:path';
import { checkNativeTree, humanSummary } from './native-policy-lib.mjs';

function parseArguments(argv) {
  const options = { compareGolden: true, evidence: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--no-golden') {
      options.compareGolden = false;
      continue;
    }
    if (!['--root', '--profile', '--json', '--golden', '--evidence', '--team-id', '--app-group'].includes(argument)) {
      throw new Error(`unknown argument ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    if (argument === '--root') options.root = value;
    else if (argument === '--profile') options.profile = value;
    else if (argument === '--json') options.jsonPath = resolve(value);
    else if (argument === '--golden') options.golden = resolve(value);
    else if (argument === '--evidence') options.evidence.classification = value;
    else if (argument === '--team-id') options.evidence.teamId = value;
    else if (argument === '--app-group') options.evidence.appGroup = value;
    index += 1;
  }
  if (!options.root) throw new Error('--root is required');
  if (!options.profile) throw new Error('--profile is required');
  if (options.evidence.classification && !['release', 'test-fixture'].includes(options.evidence.classification)) {
    throw new Error('--evidence must be release or test-fixture');
  }
  return options;
}

try {
  const result = checkNativeTree(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${humanSummary(result)}\n`);
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`M60-03 checker invocation failed: ${message}\n`);
  process.exitCode = 2;
}
