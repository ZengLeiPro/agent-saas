#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, flatten, parseArgs, pathMatches } from './effective-config-lib.mjs';

function firstMatch(patterns, path) {
  return patterns.find((pattern) => pathMatches(pattern, path));
}

export function compareEnvironments(staging, production, policy) {
  const stagingFlat = flatten(staging);
  const productionFlat = flatten(production);
  const paths = [...new Set([...stagingFlat.keys(), ...productionFlat.keys()])].sort();
  const report = {
    schemaVersion: 1,
    environments: { staging: staging.environment, production: production.environment },
    summary: {
      mustEqualViolations: 0,
      mustDifferViolations: 0,
      approvedDifferences: 0,
      unclassifiedDifferences: 0,
    },
    mustEqualViolations: [],
    mustDifferViolations: [],
    approvedDifferences: [],
    unclassifiedDifferences: [],
  };
  const allowedPatterns = (policy.allowedDifference ?? []).map((item) => item.path);
  for (const path of paths) {
    if (firstMatch(policy.ignored ?? [], path)) continue;
    const leftPresent = stagingFlat.has(path);
    const rightPresent = productionFlat.has(path);
    const equal =
      leftPresent === rightPresent &&
      canonicalJson(stagingFlat.get(path)) === canonicalJson(productionFlat.get(path));
    const mustEqual = firstMatch(policy.mustEqual ?? [], path);
    const mustDiffer = firstMatch(policy.mustDiffer ?? [], path);
    const allowed = firstMatch(allowedPatterns, path);
    if (mustEqual && !equal) report.mustEqualViolations.push({ path, rule: mustEqual });
    else if (mustDiffer && equal) report.mustDifferViolations.push({ path, rule: mustDiffer });
    else if (!equal && allowed) report.approvedDifferences.push({ path, rule: allowed });
    else if (!equal && !mustDiffer) report.unclassifiedDifferences.push({ path });
  }
  report.summary.mustEqualViolations = report.mustEqualViolations.length;
  report.summary.mustDifferViolations = report.mustDifferViolations.length;
  report.summary.approvedDifferences = report.approvedDifferences.length;
  report.summary.unclassifiedDifferences = report.unclassifiedDifferences.length;
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.staging || !options.production) {
    throw new Error(
      'usage: compare-environments.mjs --staging <export.json> --production <export.json> [--policy <path>] [--output <new-path>]',
    );
  }
  const [staging, production, policy] = await Promise.all([
    readFile(resolve(options.staging), 'utf8').then(JSON.parse),
    readFile(resolve(options.production), 'utf8').then(JSON.parse),
    readFile(resolve(options.policy ?? 'config/governance/parity-policy.json'), 'utf8').then(
      JSON.parse,
    ),
  ]);
  const report = compareEnvironments(staging, production, policy);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) await writeFile(resolve(options.output), body, { flag: 'wx', mode: 0o600 });
  else process.stdout.write(body);
  if (
    report.summary.mustEqualViolations ||
    report.summary.mustDifferViolations ||
    report.summary.unclassifiedDifferences
  ) {
    process.exitCode = 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
