#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coverage = JSON.parse(await readFile(path.join(root, 'coverage.json'), 'utf8'));
const errors = [];
const flowFiles = [...new Set(coverage.flows.flatMap((flow) => [flow.file, ...(flow.segments ?? []).map((segment) => segment.file)]))];
for (const flowFile of flowFiles) {
  const file = path.join(root, 'flows', flowFile);
  const source = await readFile(file, 'utf8');
  if (!source.startsWith('appId: ${APP_ID}\n')) errors.push(`${flowFile}: missing injected appId`);
  if (!source.includes('\n---\n')) errors.push(`${flowFile}: missing Maestro document separator`);
  if (!source.includes('takeScreenshot:')) errors.push(`${flowFile}: missing screenshot evidence command`);
  if (/openBrowser|viewport|playwright|webView/i.test(source)) errors.push(`${flowFile}: browser evidence is forbidden`);
  if (/https?:\/\//i.test(source)) errors.push(`${flowFile}: hardcoded origin is forbidden`);
}
const config = await readFile(path.join(root, 'config.yaml'), 'utf8');
for (const flowFile of flowFiles) {
  if (!config.includes(flowFile.replace(/\.yaml$/, ''))) errors.push(`config.yaml: missing ${flowFile} execution order`);
}
if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exit(1);
}
const cli = spawnSync('maestro', ['--version'], { encoding: 'utf8' });
if (cli.error?.code === 'ENOENT') {
  process.stdout.write('Maestro CLI unavailable: deterministic static config/flow lint passed; real-device jobs must provide Maestro and will fail closed.\n');
} else if (cli.status !== 0) {
  process.stderr.write('Maestro CLI exists but is unusable.\n');
  process.exit(1);
} else {
  process.stdout.write(`Maestro CLI detected (${String(cli.stdout || cli.stderr).trim()}); deterministic config/flow lint passed.\n`);
}
