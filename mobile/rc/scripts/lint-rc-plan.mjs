#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validatePlan } from './rc-contract.mjs';

async function main() {
  const defaultPlan = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rc-plan.json');
  const plan = JSON.parse(await readFile(path.resolve(process.argv[2] ?? defaultPlan), 'utf8'));
  const result = validatePlan(plan);
  process.stdout.write(`M70-01 plan valid cases=${result.caseCount} digest=${result.planDigest}\n`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
